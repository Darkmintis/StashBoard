import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Low-level command runner. Injectable so unit tests can mock git without
 * touching a real repo.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; maxBuffer?: number }
) => Promise<ExecResult>;

const DEFAULT_MAX_BUFFER = 128 * 1024 * 1024;

export const defaultExec: ExecFn = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error && typeof error !== "string") {
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : 1;
          resolve({ code, stdout, stderr });
          return;
        }
        resolve({ code: 0, stdout, stderr });
      }
    );
  });

export class GitError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, args: string[], result: ExecResult) {
    const detail = (result.stderr || result.stdout || "").trim();
    super(
      `git ${command} ${args.join(" ")} failed (exit ${result.code})` +
        (detail ? `:\n${detail}` : "")
    );
    this.name = "GitError";
    this.command = command;
    this.args = args;
    this.exitCode = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export class StashboardError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "StashboardError";
  }
}

export class StashNotFoundError extends StashboardError {
  constructor(nameOrId: string) {
    super(`No stash found matching "${nameOrId}".`);
    this.name = "StashNotFoundError";
  }
}

export class MixedStateError extends StashboardError {
  readonly files: string[];
  constructor(files: string[]) {
    super(
      `Cannot stash ${files.length > 1 ? "these files" : "this file"} because it ` +
        "has both staged and unstaged changes. Stage everything or unstage " +
        "everything first, then try again.\n" +
        files.map((f) => `  - ${f}`).join("\n")
    );
    this.name = "MixedStateError";
    this.files = files;
  }
}

export class UnmergedError extends StashboardError {
  readonly files: string[];
  constructor(files: string[]) {
    super(
      `Cannot stash ${files.length > 1 ? "these files" : "this file"} because it has ` +
        "unresolved merge conflicts. Resolve the conflicts first.\n" +
        files.map((f) => `  - ${f}`).join("\n")
    );
    this.name = "UnmergedError";
    this.files = files;
  }
}

/** Raised by restore when `git stash apply` produced conflict markers. */
export class RestoreConflictError extends StashboardError {
  readonly conflictFiles: string[];
  readonly stashFiles: string[];
  constructor(conflictFiles: string[], stashFiles: string[]) {
    super(
      `Restoring caused conflicts in:\n` +
        conflictFiles.map((f) => `  - ${f}`).join("\n") +
        `\nResolve the markers in your editor. The stash was NOT dropped.`
    );
    this.name = "RestoreConflictError";
    this.conflictFiles = conflictFiles;
    this.stashFiles = stashFiles;
  }
}

export function isStashboardSubject(subject: string): boolean {
  return subject.includes("stashboard:");
}