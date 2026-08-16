# Changelog

All notable changes to StashBoard are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Core library (`@stashboard/core`) — pure logic over `git stash`, no VS Code
  dependencies. Save, restore, stage, rename, delete, preview, reconcile.
- **Stash Board** — a three-column drag-and-drop panel (STAGED / CHANGES /
  STASHES) in the activity bar. Drag file cards to stage, stash, restore, or
  move files between stashes. Every operation is transactional with rollback;
  rejected drops snap back with an inline error. Core board primitives build
  and swap the underlying stash commits layer-by-layer with a per-file
  `stash@{N}` ref re-resolution at swap time.
- CLI (`git stashboard`) — `add`, `list`, `show`, `restore`, `stage`, `rename`,
  `drop`. Every stash is a real `git stash` entry; user stashes are never
  touched.
- VS Code extension — StashBoard section in the Source Control sidebar, one
  group per stash, right-click "Save to Stash..." directly on Git's own
  Changes list, native diff view per file, preview of the full stash patch.
- Metadata cache at `.git/stashboard/metadata.json`, reconciled against the
  real stash list on every activation (self-healing adoption/pruning).
- Safety guarantees: restore uses `apply` (never `pop`), the stash is dropped
  only after a clean apply, and a conflicted restore never auto-drops.
  Mixed staged+unstaged files are blocked with a clear message.
