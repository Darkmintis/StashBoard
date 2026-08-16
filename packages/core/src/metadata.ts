import * as fs from "node:fs";
import * as path from "node:path";
import type { MetadataFile, Stash } from "./types";

/**
 * Metadata cache at `<gitCommonDir>/stashboard/metadata.json`.
 *
 * This is a CACHE for fast UI rendering, never the source of truth — the
 * source of truth is `git stash list`. It is reconciled against the real
 * stash list on every activation and after every mutation.
 */

export const METADATA_FILE_NAME = "metadata.json";
export const SCHEMA_VERSION = 1 as const;

export function emptyMetadata(): MetadataFile {
  return { schemaVersion: SCHEMA_VERSION, stashes: [] };
}

export function metadataDir(gitCommonDir: string): string {
  return path.join(gitCommonDir, "stashboard");
}

export function metadataPath(gitCommonDir: string): string {
  return path.join(metadataDir(gitCommonDir), METADATA_FILE_NAME);
}

/** Read metadata. Missing/corrupt files yield an empty cache, never an error. */
export function readMetadata(gitCommonDir: string): MetadataFile {
  try {
    const raw = fs.readFileSync(metadataPath(gitCommonDir), "utf8");
    const parsed = JSON.parse(raw) as MetadataFile;
    if (!Array.isArray(parsed.stashes)) return emptyMetadata();
    return { schemaVersion: SCHEMA_VERSION, stashes: parsed.stashes };
  } catch {
    return emptyMetadata();
  }
}

/**
 * Atomically write metadata: write a temp file in the same directory, then
 * rename over the real file. A crash mid-write can never corrupt the previous
 * copy.
 */
export function writeMetadata(
  gitCommonDir: string,
  data: MetadataFile
): void {
  const dir = metadataDir(gitCommonDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = metadataPath(gitCommonDir);
  const tmp = path.join(dir, `.metadata.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
}

export function addStash(meta: MetadataFile, stash: Stash): MetadataFile {
  const existing = meta.stashes.filter((s) => s.id !== stash.id);
  return { schemaVersion: SCHEMA_VERSION, stashes: [...existing, stash] };
}

export function removeStash(meta: MetadataFile, id: string): MetadataFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    stashes: meta.stashes.filter((s) => s.id !== id),
  };
}

export function upsertStash(meta: MetadataFile, stash: Stash): MetadataFile {
  const others = meta.stashes.filter((s) => s.id !== stash.id);
  return { schemaVersion: SCHEMA_VERSION, stashes: [...others, stash] };
}