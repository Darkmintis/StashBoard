import { GitError, defaultExec, type ExecFn, type ExecResult } from "./git";
import type { StashEntry } from "./types";

/**
 * Git plumbing wrappers. Every operation takes an explicit working directory
 * and an optional injectable exec runner (for unit testing).
 */

export interface GitOpts {
  cwd: string;
  exec?: ExecFn;
}

export async function runGit(
  cwd: string,
  args: string[],
  exec: ExecFn = defaultExec
): Promise<ExecResult> {
  const result = await exec("git", args, { cwd });
  if (result.code !== 0) {
    throw new GitError(args[0] ?? "git", args.slice(1), result);
  }
  return result;
}

/** `git rev-parse --git-common-dir` — where refs/stash and our metadata live. */
export async function gitCommonDir(opts: GitOpts): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec("git", ["rev-parse", "--git-common-dir"], {
    cwd: opts.cwd,
  });
  if (result.code !== 0) {
    throw new GitError("rev-parse", ["--git-common-dir"], result);
  }
  const out = result.stdout.trim();
  if (out.length === 0) {
    throw new GitError("rev-parse", ["--git-common-dir"], result);
  }
  return isPathAbsolute(out) ? out : pathJoin(opts.cwd, out);
}

/** True when the working directory is inside a git repository. */
export async function isInsideRepo(opts: GitOpts): Promise<boolean> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: opts.cwd,
  });
  return result.code === 0 && result.stdout.trim() === "true";
}

function isPathAbsolute(p: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]/.test(p) || p.startsWith("~");
}

function pathJoin(a: string, b: string): string {
  return a.replace(/[\\/]+$/, "") + "/" + b;
}

/** Parse a git version string like "git version 2.39.1.windows.1". */
export function parseGitVersion(versionString: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionString);
  if (!match) return { major: 0, minor: 0, patch: 0 };
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

/** `git --version` — used to gate features like `--staged` (needs >= 2.35). */
export async function gitVersion(opts: GitOpts): Promise<{
  major: number;
  minor: number;
  patch: number;
}> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec("git", ["--version"], { cwd: opts.cwd });
  if (result.code !== 0) {
    throw new GitError("--version", [], result);
  }
  return parseGitVersion(result.stdout);
}

export function supportsStagedStash(version: {
  major: number;
  minor: number;
}): boolean {
  return version.major > 2 || (version.major === 2 && version.minor >= 35);
}

/** `git stash list`, parsed into refs and subjects. */
export async function stashList(opts: GitOpts): Promise<StashEntry[]> {
  const result = await runGit(
    opts.cwd,
    ["stash", "list", "--format=%gd%x00%gs"],
    opts.exec
  );
  const entries: StashEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const nul = line.indexOf("\x00");
    if (nul === -1) continue;
    entries.push({
      ref: line.slice(0, nul),
      subject: line.slice(nul + 1),
    });
  }
  return entries;
}

export interface StashPushOptions extends GitOpts {
  message: string;
  files: string[];
  includeUntracked?: boolean;
  stagedOnly?: boolean;
}

/**
 * `git stash push`. Returns the new stash entry. Throws if the stash does not
 * actually appear in `git stash list` afterwards (verification is the caller's
 * crash-safety guarantee).
 */
export async function stashPush(
  opts: StashPushOptions
): Promise<StashEntry> {
  const args = ["stash", "push"];
  if (opts.includeUntracked) args.push("-u");
  if (opts.stagedOnly) args.push("--staged");
  args.push("-m", opts.message);
  if (opts.files.length > 0) args.push("--", ...opts.files);

  await runGit(opts.cwd, args, opts.exec);

  const entries = await stashList(opts);
  const match = entries.find((e) => e.subject.includes(opts.message));
  if (!match) {
    throw new GitError(
      "stash",
      ["push"],
      {
        code: 1,
        stdout: "",
        stderr:
          "stash push reported success but no matching entry was found in `git stash list`.",
      }
    );
  }
  return match;
}

/**
 * `git stash apply`. Deliberately never uses `pop`: the stash entry stays alive
 * until the caller has confirmed a clean apply and explicitly dropped it.
 * Detects conflicts via the working-tree unmerged state rather than trusting
 * the exit code, which varies across git versions.
 */
export async function stashApply(
  opts: GitOpts & { ref: string }
): Promise<{ applied: boolean; conflicts: string[] }> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec("git", ["stash", "apply", opts.ref], {
    cwd: opts.cwd,
  });
  const conflicts = await unmergedPaths({ cwd: opts.cwd, exec });
  if (conflicts.length > 0) {
    return { applied: true, conflicts };
  }
  if (result.code !== 0) {
    throw new GitError("stash", ["apply", opts.ref], result);
  }
  return { applied: true, conflicts: [] };
}

/** `git stash drop <ref>`. */
export async function stashDrop(
  opts: GitOpts & { ref: string }
): Promise<void> {
  await runGit(opts.cwd, ["stash", "drop", opts.ref], opts.exec);
}

/** `git stash show -p` — the full patch (including untracked files). */
export async function stashShowPatch(
  opts: GitOpts & { ref: string; file?: string }
): Promise<string> {
  const args = ["stash", "show", "-p", "-u", "--textconv", opts.ref];
  if (opts.file) args.push("--", opts.file);
  const result = await runGit(opts.cwd, args, opts.exec);
  return result.stdout;
}

/**
 * `git stash show --name-status` — the list of files a stash touches.
 * Parse order-preserving output using `-z` so paths are unquoted.
 */
export async function stashFiles(
  opts: GitOpts & { ref: string }
): Promise<string[]> {
  const result = await runGit(
    opts.cwd,
    ["stash", "show", "--name-status", "-u", "-z", opts.ref],
    opts.exec
  );
  return parseNameStatusZ(result.stdout);
}

/**
 * Parse `git diff ... --name-status -z` output into a list of paths.
 *
 * With `-z`, the output is `STATUS\0path\0` (renames/copies are
 * `R100\0old\0new\0`). The status and path are NUL-separated, NOT tab-separated
 * (tabs only appear without `-z`).
 */
export function parseNameStatusZ(output: string): string[] {
  const tokens = output.split("\x00").filter((t) => t.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!/^[A-Z]\d{0,3}$/.test(token) && token !== "??") continue;
    const status = token.replace(/\d+$/, "");
    const path1 = tokens[i + 1];
    if (path1 === undefined) break;
    paths.push(path1);
    i++;
    if ((status === "R" || status === "C") && i + 1 < tokens.length) {
      paths.push(tokens[i + 1]);
      i++;
    }
  }
  return paths;
}

/**
 * Set of paths currently in a merge/unmerge state
 * (`git status --porcelain -z` with statuses like UU, AA, AU, DD, ...).
 */
export async function unmergedPaths(opts: GitOpts): Promise<string[]> {
  const exec = opts.exec ?? defaultExec;
  const result = await exec("git", ["status", "--porcelain", "-z"], {
    cwd: opts.cwd,
  });
  if (result.code !== 0) {
    throw new GitError("status", ["--porcelain", "-z"], result);
  }
  const tokens = result.stdout.split("\x00").filter((t) => t.length > 0);
  const paths: string[] = [];
  for (const token of tokens) {
    const code = token.slice(0, 2);
    if (isUnmergedCode(code)) {
      paths.push(token.slice(3));
    }
  }
  return paths;
}

/** Unmerged entries show XY where both chars are drawn from {A, D, U}. */
export function isUnmergedCode(code: string): boolean {
  if (code.length < 2) return false;
  if (code === "??") return false;
  return code[0] !== " " && code[1] !== " " && /^[ADU][ADU]$/.test(code);
}
