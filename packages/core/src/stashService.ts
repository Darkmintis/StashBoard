import { randomUUID } from "node:crypto";
import {
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
  writeMetadata,
} from "./metadata";
import {
  gitCommonDir,
  gitVersion,
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
  MetadataFile,
  ReconcileResult,
  RestoreResult,
  Stash,
  StashEntry,
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