import * as fs from "node:fs";
import * as path from "node:path";
import { StashboardError, UnmergedError } from "./git";
import {
  blobModeForWorktree,
  gitCommitTree,
  gitHashObject,
  gitRevParse,
  gitRevParseOpt,
  indexEntry,
  runGit,
  stashDrop,
  treeRemoveEntry,
  treeSetEntry,
  unmergedPaths,
  type GitOpts,
} from "./stashOps";
import { collectWorkingTreeState, classifyPath } from "./validation";
import type { StashFileState } from "./types";

/** The well-known empty git tree object. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Board primitives — per-file operations over **existing** stash commits.
 *
 * Git treats the stash stack as a reflog on `refs/stash`; a stash commit has:
 *   W   the stash commit (tree = merged worktree state at stash time)
 *   W^1 the base commit (HEAD when the stash was created)
 *   W^2 the index-state commit (tree = index at stash time, parent = W^1)
 *   W^3 the untracked root commit (tree holds ONLY untracked files, -u only)
 *
 * To add/remove a file in an existing stash we replay git stash's own trick:
 * build new trees with a throwaway index, compose a new stash commit with
 * `commit-tree` (parents preserved), then swap the reflog entry via
 * `stash drop` + `stash store` (the same pattern `rename()` already uses).
 */

export interface TreeShot {
  /** The stash commit's own tree (`W^{tree}`). */
  worktree: string;
  /** The index commit's tree (`W^2^{tree}`), or null when missing. */
  indexTree: string | null;
  /** The untracked commit's tree (`W^3^{tree}`), or null when missing. */
  untrackedTree: string | null;
}

export interface StashAnatomy extends TreeShot {
  /** Full stash commit sha. */
  sha: string;
  /** The stash ref (`stash@{N}`) used to resolve this stash — for `stash drop`. */
  ref: string;
  /** Base commit (`W^1`). */
  base: string;
  /** Index commit sha (`W^2`), or null when the stash is a plain 2-parent. */
  indexCommit: string | null;
  /** Untracked commit sha (`W^3`), or null. */
  untrackedCommit: string | null;
  /** The stash reflog subject/name used by `git stash list`. */
  message: string;
  /** Index commit raw subject (reused verbatim when rebuilding W^2). */
  indexMessage: string | null;
  /** Untracked commit raw subject (reused verbatim when rebuilding W^3). */
  untrackedMessage: string | null;
}

/** Blob + mode to set at a tree path; `null` in a map value means "remove". */
export interface EntryUpdate {
  mode: string;
  sha: string;
}

export interface StashCompose {
  anatomy: StashAnatomy;
  /** Path → update for the stash's own tree (and index tree where staged). */
  worktree: Map<string, EntryUpdate | null>;
  /** Path → update applied to the index commit tree (for staged moves). */
  index: Map<string, EntryUpdate | null>;
  /** Path → update applied to the untracked root commit tree. */
  untracked: Map<string, EntryUpdate | null>;
}

export interface ComposeResult {
  /** The new stash commit sha. */
  sha: string;
  /** True when an untracked root commit was created or recreated. */
  untrackedChanged: boolean;
}

export interface BuildResult extends ComposeResult {
  /** Resulting untracked tree (null when the stash collapsed to 2 parents). */
  untrackedTree: string | null;
}

/**
 * Read the anatomical parts of a stash commit. `ref` can be `stash@{N}` or a
 * full sha; the message is taken from the commit itself (not the reflog) so a
 * swap keeps the exact stash name.
 */
export async function resolveStashAnatomy(
  opts: GitOpts,
  ref: string
): Promise<StashAnatomy> {
  const sha = await gitRevParse(opts, ref);

  const base = await gitRevParse(opts, `${sha}^1`);
  const worktree = await gitRevParse(opts, `${sha}^{tree}`);
  const indexCommit = await gitRevParseOpt(opts, `${sha}^2`);
  const untrackedCommit = await gitRevParseOpt(opts, `${sha}^3`);

  const indexTree = indexCommit
    ? await gitRevParse(opts, `${indexCommit}^{tree}`)
    : null;
  const untrackedTree = untrackedCommit
    ? await gitRevParse(opts, `${untrackedCommit}^{tree}`)
    : null;

  const message = (await commitSubject(opts, sha)) ?? "";
  const indexMessage = indexCommit ? await commitSubject(opts, indexCommit) : null;
  const untrackedMessage = untrackedCommit
    ? await commitSubject(opts, untrackedCommit)
    : null;

  return {
    sha,
    ref,
    worktree,
    indexTree,
    untrackedTree,
    base,
    indexCommit,
    untrackedCommit,
    message,
    indexMessage,
    untrackedMessage,
  };
}

async function commitSubject(
  opts: GitOpts,
  sha: string
): Promise<string | null> {
  const result = await runGit(opts.cwd, ["log", "-1", "--format=%s", sha], opts.exec);
  const subject = result.stdout.trim();
  return subject.length > 0 ? subject : null;
}

/**
 * Build (but do not swap) a rewritten stash commit from a per-layer set of path
 * updates. Pure object creation — no reflog mutation — so callers can build
 * every side of a transaction before committing to any swap.
 */
export async function buildStashCommit(
  opts: GitOpts,
  compose: StashCompose
): Promise<BuildResult> {
  const { anatomy } = compose;

  // ---- 1. Layer trees -----------------------------------------------------
  let worktreeTree = anatomy.worktree;
  let indexTree = anatomy.indexTree;
  let untrackedTree = anatomy.untrackedTree;

  // Adding the first untracked file when the stash has no W^3: the untracked
  // tree starts from the well-known empty tree object.
  for (const [p, upd] of compose.worktree) {
    worktreeTree =
      upd === null
        ? await treeRemoveEntry(opts, worktreeTree, p)
        : await treeSetEntry(opts, worktreeTree, p, upd.mode, upd.sha);
  }
  for (const [p, upd] of compose.index) {
    indexTree =
      upd === null
        ? await treeRemoveEntry(opts, indexTree!, p)
        : await treeSetEntry(opts, indexTree!, p, upd.mode, upd.sha);
  }
  for (const [p, upd] of compose.untracked) {
    let base = untrackedTree;
    if (base === null) {
      if (upd === null) continue;
      base = EMPTY_TREE;
    }
    untrackedTree =
      upd === null
        ? await treeRemoveEntry(opts, base, p)
        : await treeSetEntry(opts, base, p, upd.mode, upd.sha);
  }

  // ---- 2. Rebuild W^2 / W^3 commits --------------------------------------
  let indexCommit = anatomy.indexCommit;
  if (indexTree !== null) {
    indexCommit = await gitCommitTree(opts, {
      tree: indexTree,
      parents: [anatomy.base],
      message: anatomy.indexMessage ?? anatomy.message,
    });
  }

  let untrackedCommit = anatomy.untrackedCommit;
  let untrackedChanged = false;
  if (
    untrackedTree !== null &&
    (untrackedTree !== anatomy.untrackedTree || anatomy.untrackedTree === null)
  ) {
    const uTree = untrackedTree;
    const empty = await treeIsEmpty(opts, uTree);
    // A W^3 that no longer holds anything collapses back to a 2-parent stash.
    if (empty) {
      untrackedChanged = true;
      untrackedCommit = null;
      untrackedTree = null;
    } else {
      untrackedChanged = true;
      untrackedCommit = await gitCommitTree(opts, {
        tree: uTree,
        parents: [],
        message: anatomy.untrackedMessage ?? "untracked files",
      });
    }
  }

  // ---- 3. Compose the new stash commit ------------------------------------
  const parents = [anatomy.base, indexCommit!];
  if (untrackedCommit !== null) parents.push(untrackedCommit);

  const newSha = await gitCommitTree(opts, {
    tree: worktreeTree,
    parents,
    message: anatomy.message,
  });

  // Sanity: git treats a stash by its ^2; failing here means we must not swap.
  await gitRevParse(opts, `${newSha}^2`);

  return { sha: newSha, untrackedChanged, untrackedTree };
}

/**
 * Compose and swap-stash a rewritten stash commit from a per-layer set of path
 * updates. Returns the new sha. Leaves the stash list in a consistent state on
 * success.
 */
export async function composeStash(
  opts: GitOpts,
  compose: StashCompose
): Promise<ComposeResult> {
  const built = await buildStashCommit(opts, compose);
  const sha = await swapStash(opts, {
    originalSha: compose.anatomy.sha,
    message: compose.anatomy.message,
    sha: built.sha,
  });
  return { sha, untrackedChanged: built.untrackedChanged };
}

/**
 * Atomically replace the stash entry identified by its ORIGINAL commit sha with
 * a new commit sha. The `stash@{N}` position is re-resolved from the sha at
 * swap time — never cached — because earlier swaps push new entries to the top
 * of the reflog and shift every other stash's index.
 */
export async function swapStash(
  opts: GitOpts,
  swap: { originalSha: string; message: string; sha: string }
): Promise<string> {
  const ref = await stashRefBySha(opts, swap.originalSha);
  if (!ref) {
    throw new StashboardError(
      "The stash to rewrite is no longer in `git stash list` — aborting the swap."
    );
  }
  await stashDrop({ cwd: opts.cwd, exec: opts.exec, ref });
  return swapStore(opts, swap.sha, swap.message);
}

/**
 * `git stash store -m <message> <sha>` pushes the entry to the TOP of the
 * stash list; our drop already removed the old position. Verifies by sha that
 * the swap landed and returns the entry sha.
 */
export async function swapStore(
  opts: GitOpts,
  sha: string,
  message: string
): Promise<string> {
  await runGit(opts.cwd, ["stash", "store", "-m", message, sha], opts.exec);
  if (!(await hasStashCommit(opts, sha))) {
    throw new StashboardError(
      "Stash rewrite reported success but the new commit was not found in `git stash list`."
    );
  }
  return sha;
}

/** The stash-ref (`stash@{N}`) whose commit sha matches, or null. */
export async function stashRefBySha(
  opts: GitOpts,
  sha: string
): Promise<string | null> {
  const result = await runGit(
    opts.cwd,
    ["stash", "list", "--format=%H%x00%gd"],
    opts.exec
  );
  for (const line of result.stdout.split("\n")) {
    const nul = line.indexOf("\x00");
    if (nul === -1) continue;
    if (line.slice(0, nul) === sha) return line.slice(nul + 1);
  }
  return null;
}

/** True when the given commit sha currently sits atop the stash reflog. */
export async function hasStashCommit(
  opts: GitOpts,
  sha: string
): Promise<boolean> {
  return (await stashRefBySha(opts, sha)) !== null;
}

// ---------------------------------------------------------------------------
// Per-file classifications
// ---------------------------------------------------------------------------

export interface StashFileLocation {
  /** Where the file's change lives inside the stash commit. */
  layer: "tracked" | "index" | "untracked";
  /** Blob sha (and mode) of the file's stash content, when it has one. */
  entry: EntryUpdate | null;
}

/**
 * Classify a single path inside an existing stash. Files shipped with `-u` live
 * only in W^3; otherwise a file's change is the difference between the layer
 * tree and the base tree (W^2 holds EVERY tracked file, so presence alone is
 * not enough — only a diff vs the base counts as a stash change).
 */
export async function locateInStash(
  opts: GitOpts,
  anatomy: StashAnatomy,
  p: string
): Promise<StashFileLocation> {
  const baseExpr = `${anatomy.base}^{tree}`;

  const [untrackedEntry, wEntry, w2Entry] = await Promise.all([
    anatomy.untrackedTree ? entryAtPath(opts, anatomy.untrackedTree, p) : null,
    entryAtPath(opts, anatomy.worktree, p),
    anatomy.indexTree ? entryAtPath(opts, anatomy.indexTree, p) : null,
  ]);

  if (untrackedEntry) {
    return { layer: "untracked", entry: untrackedEntry };
  }
  const baseEntry = await entryAtPath(opts, baseExpr, p);
  const differs = (a: EntryUpdate | null, b: EntryUpdate | null): boolean =>
    (a?.sha ?? "") !== (b?.sha ?? "") || (a?.mode ?? "") !== (b?.mode ?? "");

  // Staged change: index tree differs from base.
  if (w2Entry && differs(w2Entry, baseEntry)) {
    return { layer: "index", entry: wEntry };
  }
  // Unstaged change: only the worktree tree differs from base.
  if (wEntry && differs(wEntry, baseEntry)) {
    return { layer: "tracked", entry: wEntry };
  }
  return { layer: "tracked", entry: null };
}

/** True when a tree has no entries at all. */
export async function treeIsEmpty(
  opts: GitOpts,
  tree: string
): Promise<boolean> {
  const result = await runGit(
    opts.cwd,
    ["ls-tree", "--name-only", "-z", tree],
    opts.exec
  );
  return result.stdout.length === 0;
}

/** Read the mode+sha of a path in a tree, or null. */
export async function entryAtPath(
  opts: GitOpts,
  tree: string,
  p: string
): Promise<EntryUpdate | null> {
  const result = await runGit(opts.cwd, ["ls-tree", tree, "--", p], opts.exec);
  const line = result.stdout.trim();
  if (!line) return null;
  const m = /^(\d{6})\sblob\s([0-9a-f]{40,64})\t/.exec(line);
  if (!m) return null;
  return { mode: m[1], sha: m[2] };
}

/** Flatten every blob path+entry of a tree (`ls-tree -r -z`). */
export async function flattenTree(
  opts: GitOpts,
  tree: string
): Promise<Map<string, EntryUpdate>> {
  const result = await runGit(
    opts.cwd,
    ["ls-tree", "-r", "-z", tree],
    opts.exec
  );
  const map = new Map<string, EntryUpdate>();
  // Recursive output: "<mode> <type> <sha>\t<path>\0" per entry.
  for (const record of result.stdout.split("\x00")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const m = /^(\d{6})\sblob\s([0-9a-f]{40,64})$/.exec(record.slice(0, tab));
    if (!m) continue;
    map.set(record.slice(tab + 1), { mode: m[1], sha: m[2] });
  }
  return map;
}

/** True when the path differs between two trees (helper for staging checks). */
export async function treeDiffers(
  opts: GitOpts,
  treeA: string,
  treeB: string,
  p: string
): Promise<boolean> {
  const [a, b] = await Promise.all([
    entryAtPath(opts, treeA, p),
    entryAtPath(opts, treeB, p),
  ]);
  return (a?.sha ?? "") !== (b?.sha ?? "") || (a?.mode ?? "") !== (b?.mode ?? "");
}

// ---------------------------------------------------------------------------
// Working-tree file capture
// ---------------------------------------------------------------------------

/** Capture the current working-tree content of a path into the object store. */
export async function captureWorktreeEntry(
  opts: GitOpts,
  filePath: string
): Promise<EntryUpdate> {
  const sha = await gitHashObject(opts, filePath);
  const mode = blobModeForWorktree(fs.statSync(path.resolve(opts.cwd, filePath)));
  return { mode, sha };
}

/**
 * Classify a path in the current working tree for a board operation. Enforces
 * the same v1 safety gate as save: no mixed, no unmerged.
 */
export async function classifyForBoard(
  opts: GitOpts,
  filePath: string
): Promise<"staged" | "unstaged" | "untracked"> {
  const unmerged = await unmergedPaths(opts);
  if (unmerged.includes(filePath)) {
    throw new UnmergedError([filePath]);
  }
  const state = await collectWorkingTreeState(opts);
  const kind = classifyPath(filePath, state);
  if (kind === "clean") {
    throw new StashboardError(`"${filePath}" has no changes to move.`);
  }
  if (kind === "mixed") {
    throw new StashboardError(
      `"${filePath}" has both staged and unstaged changes — ` +
        "stage everything or unstage everything before moving it."
    );
  }
  if (kind === "unmerged") {
    throw new UnmergedError([filePath]);
  }
  return kind;
}

/** Simple holder for file-state triage used by board data collection. */
export function fileStateOfFile(state: {
  staged: Set<string>;
  unstaged: Set<string>;
  untracked: Set<string>;
}, p: string): StashFileState {
  if (state.untracked.has(p)) return "untracked";
  if (state.staged.has(p) && state.unstaged.has(p)) return "mixed";
  if (state.staged.has(p)) return "staged";
  if (state.unstaged.has(p)) return "unstaged";
  return "clean";
}