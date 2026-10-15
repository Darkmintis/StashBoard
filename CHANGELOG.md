# Changelog

All notable changes to StashBoard are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-15

### Added
- Core library (`@stashboard/core`) — pure logic over `git stash`, no VS Code
  dependencies. Save, restore, stage, rename, delete, preview, reconcile.
- **Stash Board** — three-column drag-and-drop board in the activity bar and as
  a full editor panel (`StashBoard: Open Board`). Stage / unstage, create a
  stash from a dropped file or **New stash**, restore / stage / rename / delete
  whole stashes from card actions, move files between stashes. Every operation
  is transactional with rollback; rejected drops snap back with an inline error.
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
- GitHub Actions CI workflow — builds, typechecks, and runs the full test suite
  on every push and pull request.
- GitHub Actions release workflow — builds and packages the `.vsix`, publishes
  it as a GitHub Release on version tags (`git tag v0.1.0 && git push origin
  v0.1.0`). Developers can download the `.vsix` and install it locally with
  `code --install-extension stashboard-0.1.0.vsix` before marketplace launch.

### Fixed
- **`show --file` scoped diff** — `git stash show` doesn't support pathspec
  filtering (errors with "Too many revisions specified"). Replaced with
  `git diff <stash>^1 <stash> -- <file>` for tracked files, falling back to
  `git diff <empty-tree> <stash>^3 -- <file>` for untracked files.
- **`boardView()` mixed-file double-listing** — a file with both staged and
  unstaged changes was listed in both columns. `boardView()` now deduplicates
  via `classifyPath` with a `seen` set, so each file appears exactly once.
- **Content provider for untracked stash files** — `git show <ref>:<file>`
  can't resolve files that only exist in the untracked root tree (`^3`).
  Added a `^3` fallback: `git show <ref>^3:<file>`.
- **`.dot.mixed` CSS class** — mixed-state files had no dot color in the board
  webview. Added `.dot.mixed { background: #d3c960; }`.

### Tests
- 24 new tests added (5 `stashShowPatch`, 2 `previewFile`, 5 `boardView`,
  6 CLI, 1 `isStashboardSubject`, 1 full-preview). Total: **72 tests**, all
  passing.
