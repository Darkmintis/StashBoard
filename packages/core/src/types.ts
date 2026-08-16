export type FileStateKind =
  | "staged"
  | "unstaged"
  | "untracked"
  | "mixed"
  | "unmerged"
  | "clean";

export interface ClassifiedFile {
  /** Path as given by the caller. */
  path: string;
  kind: FileStateKind;
}

export interface StashEntry {
  /** e.g. "stash@{0}" — never cached long-term, always re-resolved. */
  ref: string;
  /** Full stash message/subject, e.g. "On main: stashboard:<uuid>:<name>". */
  subject: string;
}

export interface Stash {
  /** uuid-v4 — also embedded in the stash message as `stashboard:<id>:<name>`. */
  id: string;
  name: string;
  /** Best-effort cached ref. Always re-resolve before use. */
  stashRef: string;
  files: string[];
  createdAt: string;
  branch: string;
  baseCommit: string;
  includesUntracked: boolean;
  /** True when this stash was adopted from an orphaned git stash during reconcile. */
  recovered?: boolean;
}

export interface MetadataFile {
  schemaVersion: 1;
  stashes: Stash[];
}

export interface ReconcileResult {
  adopted: number;
  pruned: number;
  changed: boolean;
}

export type RestoreStatus = "restored" | "staged" | "conflict" | "failed";

export interface RestoreResult {
  status: RestoreStatus;
  /** Files affected by the restore (from the stash). */
  files: string[];
  /** Only present on conflict: paths left with conflict markers. */
  conflictFiles?: string[];
  /** Human-readable detail (conflict summary, failure reason). */
  message?: string;
}

/** A file's change state as surfaced on the Stash Board columns. */
export type StashFileState =
  | "staged"
  | "unstaged"
  | "untracked"
  | "mixed"
  | "clean";

/** A single file card on the Board CHANGES column. */
export interface BoardFile {
  path: string;
  state: StashFileState;
}

/** A single file inside a stash card on the Board STASHES column. */
export interface BoardStashFile {
  path: string;
  layer: "tracked" | "index" | "untracked";
  entry: { mode: string; sha: string };
}

/** One stash card on the Board STASHES column. */
export interface BoardStashEntry {
  id: string;
  name: string;
  files: BoardStashFile[];
}

/** The full Stash Board view model. */
export interface BoardView {
  changes: BoardFile[];
  stashes: BoardStashEntry[];
}
