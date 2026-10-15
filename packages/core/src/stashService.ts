import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  BoardConflictError,
  StashboardError,
  MixedStateError,
  RestoreConflictError,
  StashNotFoundError,
  UnmergedError,
  isStashboardSubject,
} from "./git";
import {
  addStash,
  readMetadata,
  removeStash,
  upsertStash,
  writeMetadata,
} from "./metadata";
import {
  buildStashCommit,
  captureWorktreeEntry,
  classifyForBoard,
  composeStash,
  entryAtPath,
  locateInStash,
  resolveStashAnatomy,
  swapStash,
  type EntryUpdate,
  type StashAnatomy,
} from "./board";
import {
  gitCommonDir,
  gitVersion,
  indexEntry,
  isInsideRepo,
  runGit,
  stashApply,
  stashDrop,
  stashFiles,
  stashList,
  stashPush,
  stashShowPatch,
  supportsStagedStash,
  type GitOpts,
} from "./stashOps";
import { classifyPath, collectWorkingTreeState } from "./validation";
import type {
  FileStateKind,
  MetadataFile,
  ReconcileResult,
  RestoreResult,
  Stash,
  StashEntry,
  BoardFile,
  BoardStashEntry,
  BoardStashFile,
  BoardView,
} from "./types";

const STASHBOARD_TOKEN = "stashboard:";

export interface SaveOptions {
  stagedOnly?: boolean;
}

export interface RestoreOptions {
  /** When true, stage the restored files instead of leaving them unstaged. */
  stage?: boolean;
}

interface ResolvedStash {
  stash: Stash;
  entry: StashEntry;
  /** True when the stash came from metadata; false when adopted from an orphan. */
  inMetadata: boolean;
}

/**
 * The real StashBoard API surface. Pure logic, no VS Code imports — used by both
 * the CLI and the extension.
 */
export class StashService {
  private readonly opts: GitOpts;

  constructor(opts: GitOpts) {
    this.opts = opts;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  /** All stashes, reconciled lazily against the real stash list. */
  async listStashes(): Promise<Stash[]> {
    await this.reconcile();
    const meta = await this.readMetadata();
    return meta.stashes.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /** Read raw metadata cache without mutating. */
  async readMetadata(): Promise<MetadataFile> {
    const commonDir = await gitCommonDir(this.opts);
    return readMetadata(commonDir);
  }

  async preview(nameOrId: string): Promise<string> {
    const { entry } = await this.resolveStash(nameOrId);
    return stashShowPatch({ cwd: this.opts.cwd, exec: this.opts.exec, ref: entry.ref });
  }

  /** Preview a single file's diff within a stash. */
  async previewFile(stash: Stash, file: string): Promise<string> {
    const { entry } = await this.resolveStash(stash.id);
    return stashShowPatch({
      cwd: this.opts.cwd,
      exec: this.opts.exec,
      ref: entry.ref,
      file,
    });
  }

  /** Public resolve: returns the stash only if its git stash entry still exists. */
  async resolvePublicStash(nameOrId: string): Promise<Stash> {
    const { stash } = await this.resolveStash(nameOrId);
    return stash;
  }

  /** Freshly resolve the stash ref for a stash (never trust a cached index). */
  async getStashRef(nameOrId: string): Promise<string> {
    const { entry } = await this.resolveStash(nameOrId);
    return entry.ref;
  }

  /** Save the given files into a new named stash. */
  async save(
    paths: string[],
    name: string,
    options: SaveOptions = {}
  ): Promise<Stash> {
    if (!name || name.trim().length === 0) {
      throw new StashboardError("A stash name is required.");
    }
    if (paths.length === 0) {
      throw new StashboardError("No files selected to stash.");
    }

    const state = await collectWorkingTreeState(this.opts);
    const classified = paths.map((p) => ({ path: p, kind: classifyPath(p, state) }));

    const mixed = classified.filter((f) => f.kind === "mixed");
    const unmerged = classified.filter((f) => f.kind === "unmerged");
    if (mixed.length > 0) {
      throw new MixedStateError(mixed.map((f) => f.path));
    }
    if (unmerged.length > 0) {
      throw new UnmergedError(unmerged.map((f) => f.path));
    }

    const stasheable = classified.filter((f) => f.kind !== "clean");
    if (stasheable.length === 0) {
      throw new StashboardError("None of the selected files have changes to stash.");
    }

    const stagedOnly = options.stagedOnly ?? false;
    if (stagedOnly && stasheable.some((f) => f.kind !== "staged")) {
      throw new StashboardError(
        "--staged requires every selected file to have only staged changes."
      );
    }
    if (stagedOnly) {
      const v = await gitVersion(this.opts);
      if (!supportsStagedStash(v)) {
        throw new StashboardError(
          `--staged needs git >= 2.35 (you have ${v.major}.${v.minor}).`
        );
      }
    }

    const id = randomUUID();
    const cleanName = name.trim();
    const message = `${STASHBOARD_TOKEN}${id}:${cleanName}`;
    const includesUntracked = stasheable.some((f) => f.kind === "untracked");

    const entry = await stashPush({
      cwd: this.opts.cwd,
      exec: this.opts.exec,
      message,
      files: stasheable.map((f) => f.path),
      includeUntracked: includesUntracked,
      stagedOnly,
    });

    const [branch, baseCommit] = await Promise.all([
      this.currentBranch(),
      this.currentCommit(),
    ]);

    const stash: Stash = {
      id,
      name: cleanName,
      stashRef: entry.ref,
      files: stasheable.map((f) => f.path),
      createdAt: new Date().toISOString(),
      branch,
      baseCommit,
      includesUntracked,
    };

    const commonDir = await gitCommonDir(this.opts);
    const meta = readMetadata(commonDir);
    writeMetadata(commonDir, addStash(meta, stash));
    return stash;
  }

  /** Restore a stash into the working tree (apply, then drop on clean success). */
  async restore(nameOrId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const { stash, entry } = await this.resolveStash(nameOrId);
    return this.applyStash(stash, entry, options);
  }

  /** Restore a stash directly into the staged area. */
  async stage(nameOrId: string): Promise<RestoreResult> {
    return this.restore(nameOrId, { stage: true });
  }

  /**
   * After a conflicted restore, revert the attempted apply so the working tree
   * is back to its pre-restore state. The stash is untouched. Only tracked
   * files that exist at HEAD are reverted (this also clears unmerged index
   * entries); files the apply created are left alone.
   */
  async discardRestoreAttempt(nameOrId: string, conflictFiles: string[]): Promise<void> {
    if (conflictFiles.length === 0) return;
    const tracked = await runGit(
      this.opts.cwd,
      ["ls-files", "--", ...conflictFiles],
      this.opts.exec
    );
    const paths = [...new Set(
      tracked.stdout
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    )];
    if (paths.length === 0) return;
    await runGit(this.opts.cwd, ["checkout", "HEAD", "--", ...paths], this.opts.exec);
  }

  /** Rename a stash (rewrites the stash message + metadata). */
  async rename(nameOrId: string, newName: string): Promise<Stash> {
    const cleanName = newName.trim();
    if (!cleanName) throw new StashboardError("A new name is required.");
    const { stash, entry, inMetadata } = await this.resolveStash(nameOrId);
    if (stash.name === cleanName) return stash;

    const commonDir = await gitCommonDir(this.opts);
    const message = `${STASHBOARD_TOKEN}${stash.id}:${cleanName}`;

    // Rebuild the stash commit with a new message, preserving tree + parents.
    const sha = (await runGit(this.opts.cwd, ["rev-parse", entry.ref], this.opts.exec)).stdout.trim();
    const parents = ["-p", `${sha}^1`, "-p", `${sha}^2`];
    const hasThird = await this.hasParent(sha, 3);
    if (hasThird) parents.push("-p", `${sha}^3`);

    const newSha = (
      await runGit(
        this.opts.cwd,
        ["commit-tree", `${sha}^{tree}`, ...parents, "-m", message],
        this.opts.exec
      )
    ).stdout.trim();

    // Sanity-check the crafted commit is stash-like (2 parents) before touching
    // the real stash list.
    await runGit(this.opts.cwd, ["rev-parse", "--verify", `${newSha}^2`], this.opts.exec);

    // Drop the old entry first (its cached ref is only valid BEFORE the new one
    // is stored, since storing pushes the new entry to the top of the list).
    await stashDrop({ cwd: this.opts.cwd, exec: this.opts.exec, ref: entry.ref });
    await runGit(this.opts.cwd, ["stash", "store", "-m", message, newSha], this.opts.exec);

    // Verify the rename actually landed in `git stash list`.
    const after = await stashList(this.opts);
    if (!after.some((e) => e.subject.includes(message))) {
      throw new StashboardError(
        "Rename reported success but the stash message was not updated. " +
          "Check `git stash list` — your data is safe."
      );
    }

    const updated: Stash = { ...stash, name: cleanName, stashRef: newSha };
    if (inMetadata) {
      const meta = readMetadata(commonDir);
      const idx = meta.stashes.findIndex((s) => s.id === stash.id);
      if (idx !== -1) meta.stashes[idx] = updated;
      writeMetadata(commonDir, meta);
    }
    return updated;
  }

  /** Delete a stash (confirmation is the caller's job). */
  async delete(nameOrId: string): Promise<void> {
    const { stash, entry, inMetadata } = await this.resolveStash(nameOrId);
    await stashDrop({ cwd: this.opts.cwd, exec: this.opts.exec, ref: entry.ref });
    if (inMetadata) {
      const commonDir = await gitCommonDir(this.opts);
      const meta = readMetadata(commonDir);
      writeMetadata(commonDir, removeStash(meta, stash.id));
    }
  }

  /**
   * Reconcile metadata cache against the real stash list:
   *  - prune metadata entries whose stash was dropped manually,
   *  - adopt orphaned stashboard stashes as "Recovered Stashes".
   */
  async reconcile(): Promise<ReconcileResult> {
    const entries = (await stashList(this.opts)).filter((e) =>
      isStashboardSubject(e.subject)
    );
    const commonDir = await gitCommonDir(this.opts);
    const meta = readMetadata(commonDir);

    const byId = new Map<string, StashEntry>();
    for (const e of entries) {
      const parsed = parseStashSubject(e.subject);
      if (parsed) byId.set(parsed.id, e);
    }

    let changed = false;
    const pruned: string[] = [];
    const retained: Stash[] = [];

    for (const stash of meta.stashes) {
      const entry = byId.get(stash.id);
      if (!entry) {
        changed = true;
        pruned.push(stash.name);
      } else {
        retained.push({ ...stash, stashRef: entry.ref });
        byId.delete(stash.id);
      }
    }

    const adoptedStashes: Stash[] = [];
    for (const [id, entry] of byId) {
      changed = true;
      adoptedStashes.push(await this.adoptOrphan(id, entry));
    }

    const merged: Stash[] = [...retained, ...adoptedStashes];
    const result: MetadataFile = { schemaVersion: 1, stashes: merged };
    if (changed) writeMetadata(commonDir, result);
    return { adopted: adoptedStashes.length, pruned: pruned.length, changed };
  }

  /** A stash exists only if its underlying git stash entry does; resolve fresh refs. */
  async hasStash(nameOrId: string): Promise<boolean> {
    try {
      await this.resolveStash(nameOrId);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Stash Board operations
  // ---------------------------------------------------------------------------

  /**
   * Stage working changes of `path` (CHANGES → STAGED). Pure `git add`; the
   * path must currently be unstaged or untracked.
   */
  async boardStage(path: string): Promise<void> {
    const kind = await classifyForBoard(this.opts, path);
    if (kind === "staged") return;
    await runGit(this.opts.cwd, ["add", "--", path], this.opts.exec);
  }

  /**
   * Move a path's working change into an existing stash (CHANGES → STASHES).
   * The stash gains the path at the layer matching its current kind; the
   * working-change copy is then reverted so the change lives only in the stash.
   */
  async boardAddToStash(nameOrId: string, path: string): Promise<void> {
    const { anatomy } = await this.resolveBoardStash(nameOrId);
    const kind = await classifyForBoard(this.opts, path);

    const capture: EntryUpdate =
      kind === "staged"
        ? (await indexEntry(this.opts, path))!
        : await captureWorktreeEntry(this.opts, path);

    // Rebuild the stash with the path added to the right layer(s).
    const worktree = new Map<string, EntryUpdate | null>();
    const index = new Map<string, EntryUpdate | null>();
    const untracked = new Map<string, EntryUpdate | null>();
    switch (kind) {
      case "untracked":
        untracked.set(path, capture);
        break;
      case "staged":
        // Staged files live in both the worktree tree (W) and the index tree (W^2).
        worktree.set(path, capture);
        index.set(path, capture);
        break;
      default:
        worktree.set(path, capture);
    }

    const compose = {
      anatomy,
      worktree,
      index,
      untracked,
    };
    await composeStash(this.opts, compose);
    await this.assimilateMetadata(anatomy.message);

    // Revert the working-tree change now that a safe copy lives in the stash.
    if (kind === "untracked") {
      fs.rmSync(nodePath.resolve(this.opts.cwd, path), { force: true });
    } else if (kind === "staged") {
      // Staged: reset index + worktree back to HEAD.
      await runGit(this.opts.cwd, ["reset", "-q", "--", path], this.opts.exec);
      await runGit(this.opts.cwd, ["checkout", "--", path], this.opts.exec);
    } else {
      // Unstaged: worktree back to index (index already == HEAD for the file).
      await runGit(this.opts.cwd, ["checkout", "--", path], this.opts.exec);
    }
  }

  /**
   * Restore a single path from a stash back into the working tree
   * (STASHES → CHANGES, or STASHES → STAGED when `stage` is set). The path is
   * removed from the stash, mirroring a per-file pop.
   */
  async boardRestoreFromStash(
    nameOrId: string,
    path: string,
    options: { stage?: boolean } = {}
  ): Promise<void> {
    const { anatomy } = await this.resolveBoardStash(nameOrId);
    const located = await locateInStash(this.opts, anatomy, path);
    if (!located.entry) {
      throw new StashboardError(`"${path}" is not a change in that stash.`);
    }

    const targetKind = await this.workingStateOf(path);
    // Restoring onto an existing working change would clobber it — conflict.
    if (targetKind !== "clean") {
      throw new BoardConflictError(
        path,
        "the working tree already has changes there."
      );
    }

    // 1. Materialize the stash's content into the working tree.
    const sourceTree =
      located.layer === "untracked"
        ? anatomy.untrackedTree!
        : anatomy.worktree;
    await runGit(
      this.opts.cwd,
      ["restore", "--source=" + sourceTree, "--worktree", "--", path],
      this.opts.exec
    );
    if (options.stage) {
      await runGit(this.opts.cwd, ["add", "--", path], this.opts.exec);
    }

    // 2. Remove the path from the stash (best-effort rollback on failure).
    const removeMaps = await this.removeFromStashCompose(anatomy, path);
    const restoreCompose = { anatomy, ...removeMaps };
    try {
      await composeStash(this.opts, restoreCompose);
    } catch {
      // The swap failed. Roll back our working-tree write so we leave no trace:
      // the target was clean (== HEAD, or an untracked/absent file) before.
      await this.rollbackCleanPath(path);
      throw new StashboardError(
        `Could not update the stash for "${path}". Its content was written to ` +
          "your working tree but the stash was left untouched — run the " +
          "restore again once the underlying issue is fixed."
      );
    }
    await this.assimilateMetadata(anatomy.message);
  }

  /**
   * Move a path from one stash to another (STASHES ⇄ STASHES). Both stashes are
   * rewritten transactionally: the target gains the file at the source's layer,
   * the source loses it.
   */
  async boardMoveBetweenStashes(
    sourceNameOrId: string,
    targetNameOrId: string,
    path: string
  ): Promise<void> {
    const source = await this.resolveBoardStash(sourceNameOrId);
    const target = await this.resolveBoardStash(targetNameOrId);

    const located = await locateInStash(this.opts, source.anatomy, path);
    if (!located.entry) {
      throw new StashboardError(`"${path}" is not a change in that stash.`);
    }

    const targetEntry = await locateInStash(this.opts, target.anatomy, path);
    if (targetEntry.entry && targetEntry.entry.sha !== located.entry.sha) {
      const targetStash = await this.resolvePublicStash(targetNameOrId);
      throw new BoardConflictError(
        path,
        `it already has a different change in stash "${targetStash.name}".`
      );
    }

    // Build BOTH new commits before touching any real reflog entry.
    const srcLoc = { layer: located.layer, entry: located.entry };
    const addMaps = this.addToStashCompose(srcLoc, path);
    const { sha: targetSha } = await buildStashCommit(this.opts, {
      anatomy: target.anatomy,
      worktree: addMaps.worktree,
      index: addMaps.index,
      untracked: addMaps.untracked,
    });

    const removeMaps = await this.removeFromStashCompose(source.anatomy, path);
    const { sha: sourceSha } = await buildStashCommit(this.opts, {
      anatomy: source.anatomy,
      worktree: removeMaps.worktree,
      index: removeMaps.index,
      untracked: removeMaps.untracked,
    });

    // Transaction: swap target first, then source; roll the target back if the
    // source swap fails so the file is never in neither stash.
    await swapStash(this.opts, {
      originalSha: target.anatomy.sha,
      message: target.anatomy.message,
      sha: targetSha,
    });
    try {
      await swapStash(this.opts, {
        originalSha: source.anatomy.sha,
        message: source.anatomy.message,
        sha: sourceSha,
      });
    } catch (err) {
      await swapStash(this.opts, {
        originalSha: targetSha,
        message: target.anatomy.message,
        sha: target.anatomy.sha,
      });
      throw err;
    }

    await this.assimilateMetadata(source.anatomy.message);
    await this.assimilateMetadata(target.anatomy.message);
  }

  /** Board view model: per-column working-tree files + per-stash files. */
  async boardView(): Promise<BoardView> {
    const state = await collectWorkingTreeState(this.opts);
    const changes: BoardFile[] = [];
    // Collect all unique changed paths, classifying each through `classifyPath`
    // so a file with both staged AND unstaged changes appears once (as "mixed")
    // instead of being double-listed across the STAGED and CHANGES columns.
    const seen = new Set<string>();
    for (const p of [
      ...state.staged,
      ...state.unstaged,
      ...state.untracked,
      ...state.unmerged,
    ]) {
      if (seen.has(p)) continue;
      seen.add(p);
      const kind = classifyPath(p, state);
      if (kind === "clean" || kind === "unmerged") continue;
      changes.push({ path: p, state: kind });
    }

    const stashes: BoardStashEntry[] = [];
    for (const stash of await this.listStashes()) {
      const { anatomy } = await this.resolveBoardStash(stash.id);
      const files: BoardStashFile[] = [];
      for (const f of stash.files ?? []) {
        const located = await locateInStash(this.opts, anatomy, f);
        if (!located.entry) continue;
        files.push({
          path: f,
          layer: located.layer,
          entry: located.entry,
        });
      }
      stashes.push({ id: stash.id, name: stash.name, files });
    }

    return { changes, stashes };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async applyStash(
    stash: Stash,
    entry: StashEntry,
    options: RestoreOptions
  ): Promise<RestoreResult> {
    const { applied, conflicts } = await stashApply({
      cwd: this.opts.cwd,
      exec: this.opts.exec,
      ref: entry.ref,
    });
    void applied;

    const files = await stashFiles({
      cwd: this.opts.cwd,
      exec: this.opts.exec,
      ref: entry.ref,
    });

    if (conflicts.length > 0) {
      throw new RestoreConflictError(conflicts, files);
    }

    if (options.stage) {
      await runGit(this.opts.cwd, ["add", "--", ...files], this.opts.exec);
    }

    await stashDrop({ cwd: this.opts.cwd, exec: this.opts.exec, ref: entry.ref });

    const commonDir = await gitCommonDir(this.opts);
    const meta = readMetadata(commonDir);
    writeMetadata(commonDir, removeStash(meta, stash.id));

    return {
      status: options.stage ? "staged" : "restored",
      files,
    };
  }

  private async adoptOrphan(id: string, entry: StashEntry): Promise<Stash> {
    const commonDir = await gitCommonDir(this.opts);
    const parsed = parseStashSubject(entry.subject);
    const [files, createdAt, baseCommit, includesUntracked] = await Promise.all([
      stashFiles({ cwd: this.opts.cwd, exec: this.opts.exec, ref: entry.ref }),
      this.stashCommitDate(entry.ref),
      this.firstParent(entry.ref),
      this.hasThirdParent(entry.ref),
    ]);
    const branch = parsed?.branch ?? "";
    return {
      id,
      name: parsed?.name ?? "Recovered Stash",
      stashRef: entry.ref,
      files,
      createdAt,
      branch,
      baseCommit,
      includesUntracked,
      recovered: true,
    };
  }

  private async resolveStash(nameOrId: string): Promise<ResolvedStash> {
    const entries = (await stashList(this.opts)).filter((e) =>
      isStashboardSubject(e.subject)
    );
    const byId = new Map<string, StashEntry>();
    const byName = new Map<string, StashEntry>();
    for (const e of entries) {
      const parsed = parseStashSubject(e.subject);
      if (!parsed) continue;
      byId.set(parsed.id, e);
      byName.set(parsed.name, e);
    }

    const meta = await this.readMetadata();

    // 1. Match by exact id in metadata.
    const metaById = meta.stashes.find((s) => s.id === nameOrId);
    if (metaById && byId.has(metaById.id)) {
      return { stash: metaById, entry: byId.get(metaById.id)!, inMetadata: true };
    }

    // 2. Match by exact name (case-insensitive) in metadata.
    const lower = nameOrId.toLowerCase();
    const metaByName = meta.stashes.filter((s) => s.name.toLowerCase() === lower);
    if (metaByName.length > 1) {
      throw new StashboardError(
        `Multiple stashes are named "${nameOrId}". Use a stash id.`
      );
    }
    if (metaByName.length === 1) {
      const s = metaByName[0];
      const e = byId.get(s.id);
      if (e) return { stash: s, entry: e, inMetadata: true };
    }

    // 3. Match against orphaned stashes not yet in metadata.
    const orphanId = byId.get(nameOrId);
    if (orphanId) {
      const stash = await this.adoptOrphan(nameOrId, orphanId);
      return { stash, entry: orphanId, inMetadata: false };
    }
    const orphanName = byName.get(nameOrId);
    if (orphanName) {
      const stash = await this.adoptOrphan(orphanName.subject, orphanName);
      return { stash, entry: orphanName, inMetadata: false };
    }

    throw new StashNotFoundError(nameOrId);
  }

  private async currentBranch(): Promise<string> {
    const result = await runGit(
      this.opts.cwd,
      ["rev-parse", "--abbrev-ref", "HEAD"],
      this.opts.exec
    );
    const branch = result.stdout.trim();
    return branch && branch !== "HEAD" ? branch : "";
  }

  private async currentCommit(): Promise<string> {
    const result = await runGit(this.opts.cwd, ["rev-parse", "HEAD"], this.opts.exec);
    return result.stdout.trim();
  }

  private async stashCommitDate(ref: string): Promise<string> {
    const result = await runGit(
      this.opts.cwd,
      ["show", "-s", "--format=%aI", ref],
      this.opts.exec
    );
    return result.stdout.trim();
  }

  private async firstParent(ref: string): Promise<string> {
    const result = await runGit(this.opts.cwd, ["rev-parse", `${ref}^1`], this.opts.exec);
    return result.stdout.trim();
  }

  private async hasParent(sha: string, n: number): Promise<boolean> {
    return this.parentExists(`${sha}^${n}`);
  }

  private async hasThirdParent(ref: string): Promise<boolean> {
    return this.parentExists(`${ref}^3`);
  }

  private async parentExists(refExpr: string): Promise<boolean> {
    try {
      const result = await runGit(
        this.opts.cwd,
        ["rev-parse", "--verify", "-q", refExpr],
        this.opts.exec
      );
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async resolveBoardStash(nameOrId: string): Promise<{
    entry: StashEntry;
    anatomy: StashAnatomy;
  }> {
    const { entry } = await this.resolveStash(nameOrId);
    const anatomy = await resolveStashAnatomy(this.opts, entry.ref);
    return { entry, anatomy };
  }

  /**
   * Build the three layer maps that remove `path`'s change from a stash.
   * Removal means "the stash records no change for this path": the worktree and
   * index trees go back to the base entry (or are dropped when the path did not
   * exist at base), and any untracked-root entry is deleted.
   */
  private async removeFromStashCompose(
    anatomy: StashAnatomy,
    p: string
  ): Promise<{
    worktree: Map<string, EntryUpdate | null>;
    index: Map<string, EntryUpdate | null>;
    untracked: Map<string, EntryUpdate | null>;
  }> {
    const baseEntry = await entryAtPath(this.opts, `${anatomy.base}^{tree}`, p);
    const toBase: EntryUpdate | null = baseEntry ?? null;

    const worktree = new Map<string, EntryUpdate | null>();
    const index = new Map<string, EntryUpdate | null>();
    const untracked = new Map<string, EntryUpdate | null>();

    // The worktree tree always records the change (tracked or staged).
    worktree.set(p, toBase);
    // The index tree carries it when the change was staged; resetting it is a
    // no-op tree-wise when the path was only unstaged.
    if (anatomy.indexTree) index.set(p, toBase);
    // Untracked files live only in W^3 — remove them outright.
    if (anatomy.untrackedTree) untracked.set(p, null);
    return { worktree, index, untracked };
  }

  /** Build the layer maps that add `entry` to a stash at its source layer. */
  private addToStashCompose(
    located: { layer: "tracked" | "index" | "untracked"; entry: EntryUpdate },
    p: string
  ): {
    worktree: Map<string, EntryUpdate | null>;
    index: Map<string, EntryUpdate | null>;
    untracked: Map<string, EntryUpdate | null>;
  } {
    const worktree = new Map<string, EntryUpdate | null>();
    const index = new Map<string, EntryUpdate | null>();
    const untracked = new Map<string, EntryUpdate | null>();
    if (located.layer === "untracked") {
      untracked.set(p, located.entry);
    } else {
      worktree.set(p, located.entry);
      if (located.layer === "index") index.set(p, located.entry);
    }
    return { worktree, index, untracked };
  }

  /**
   * Refresh the metadata entry for the stash whose message matches, after a
   * board mutation rewrote its git objects (files list may have changed).
   */
  private async assimilateMetadata(subject: string): Promise<void> {
    const entries = await stashList(this.opts);
    const entry = entries.find((e) => e.subject === subject);
    if (!entry) return;
    const parsed = parseStashSubject(entry.subject);
    if (!parsed) return;
    const commonDir = await gitCommonDir(this.opts);
    const meta = readMetadata(commonDir);
    const idx = meta.stashes.findIndex((s) => s.id === parsed.id);
    if (idx === -1) return;
    const files = await stashFiles({
      cwd: this.opts.cwd,
      exec: this.opts.exec,
      ref: entry.ref,
    });
    const updated: Stash = {
      ...meta.stashes[idx],
      stashRef: entry.ref,
      files,
      includesUntracked: await this.hasThirdParent(entry.ref),
    };
    writeMetadata(commonDir, upsertStash(meta, updated));
  }

  /**
   * Classify the current working-tree state of a path WITHOUT throwing on
   * clean/mixed (unlike `classifyForBoard`) — used for board conflict guards.
   */
  private async workingStateOf(p: string): Promise<FileStateKind> {
    const state = await collectWorkingTreeState(this.opts);
    return classifyPath(p, state);
  }

  /**
   * Undo a working-tree write that happened on top of a clean target: unstage,
   * then restore the path from HEAD; a file that is not in HEAD is deleted.
   */
  private async rollbackCleanPath(p: string): Promise<void> {
    try {
      await runGit(this.opts.cwd, ["reset", "-q", "--", p], this.opts.exec);
    } catch {
      // Not staged; nothing to reset.
    }
    try {
      await runGit(this.opts.cwd, ["restore", "--source=HEAD", "--worktree", "--", p], this.opts.exec);
    } catch {
      fs.rmSync(nodePath.resolve(this.opts.cwd, p), { force: true });
    }
  }
}

interface ParsedStashSubject {
  id: string;
  name: string;
  branch?: string;
}

/** Parse a `stashboard:<uuid>:<name>` message (which may have an `On <branch>:` prefix). */
export function parseStashSubject(subject: string): ParsedStashSubject | null {
  const idx = subject.indexOf(STASHBOARD_TOKEN);
  if (idx === -1) return null;
  const rest = subject.slice(idx + STASHBOARD_TOKEN.length);
  const colon = rest.indexOf(":");
  if (colon === -1) return null;
  const id = rest.slice(0, colon);
  const name = rest.slice(colon + 1);
  if (!id || !name) return null;

  // Recover the branch from an "On <branch>:" prefix if present.
  const prefix = subject.slice(0, idx);
  const onMatch = /^On\s+(.+):\s*$/.exec(prefix);
  return { id, name, branch: onMatch ? onMatch[1] : undefined };
}