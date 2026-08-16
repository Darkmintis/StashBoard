import { runGit, unmergedPaths, parseNameStatusZ } from "./stashOps";
import type { ClassifiedFile, FileStateKind } from "./types";
import type { GitOpts } from "./stashOps";

/**
 * Working-tree analysis for the "save to stash" validation gate.
 *
 * A file may be shelved if it is purely staged, purely unstaged, or untracked.
 * Files with BOTH staged and unstaged changes are blocked in v1 (clear, safe
 * semantics). Files in an unmerged/conflict state are always blocked.
 */

export interface WorkingTreeState {
  staged: Set<string>;
  unstaged: Set<string>;
  untracked: Set<string>;
  unmerged: string[];
}

/** Build the full changed-file state for the working tree. */
export async function collectWorkingTreeState(
  opts: GitOpts
): Promise<WorkingTreeState> {
  const staged = await runGit(
    opts.cwd,
    ["diff", "--cached", "--name-status", "-z"],
    opts.exec
  );
  const unstaged = await runGit(
    opts.cwd,
    ["diff", "--name-status", "-z"],
    opts.exec
  );
  const untracked = await runGit(
    opts.cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    opts.exec
  );

  return {
    staged: new Set(parseNameStatusZ(staged.stdout)),
    unstaged: new Set(parseNameStatusZ(unstaged.stdout)),
    untracked: new Set(untracked.stdout.split("\x00").filter((p) => p.length > 0)),
    unmerged: await unmergedPaths(opts),
  };
}

export function classifyPath(
  path: string,
  state: WorkingTreeState
): FileStateKind {
  if (state.untracked.has(path)) return "untracked";
  if (state.unmerged.includes(path)) return "unmerged";
  const isStaged = state.staged.has(path);
  const isUnstaged = state.unstaged.has(path);
  if (isStaged && isUnstaged) return "mixed";
  if (isStaged) return "staged";
  if (isUnstaged) return "unstaged";
  return "clean";
}

/** Classify a set of user-selected paths, throwing on blocked states. */
export async function classifyFiles(
  opts: GitOpts,
  paths: string[]
): Promise<ClassifiedFile[]> {
  const state = await collectWorkingTreeState(opts);
  return paths.map((path) => ({
    path,
    kind: classifyPath(path, state),
  }));
}

/** Returns the subset of paths that cannot be shelved, by reason. */
export function blockedFiles(
  classified: ClassifiedFile[]
): { mixed: string[]; unmerged: string[]; clean: string[] } {
  const mixed: string[] = [];
  const unmerged: string[] = [];
  const clean: string[] = [];
  for (const f of classified) {
    if (f.kind === "mixed") mixed.push(f.path);
    else if (f.kind === "unmerged") unmerged.push(f.path);
    else if (f.kind === "clean") clean.push(f.path);
  }
  return { mixed, unmerged, clean };
}
