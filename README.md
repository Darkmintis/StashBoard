# StashBoard

**Named, safe stashes for your unfinished git work.** A VS Code extension and a
`git stashboard` CLI that make git's own stash visible, named, and browsable.

[![CI](https://github.com/Darkmintis/StashBoard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Darkmintis/StashBoard/actions/workflows/ci.yml)
[![Release](https://github.com/Darkmintis/StashBoard/actions/workflows/release.yml/badge.svg)](https://github.com/Darkmintis/StashBoard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Git gives you one active working tree. Real development produces several
unrelated groups of unfinished changes at once. `git stash` works, but stashes
are unnamed (`stash@{0}`), invisible, and nobody remembers
`git stash push -- <files>`. StashBoard fixes that — as a panel and a CLI.

**Every stash is a real git stash entry.** Inspect any of them any time with
plain `git stash list`. Nothing proprietary, nothing that traps your data.

---

## Why StashBoard

- **Named stashes** — `git stash push` but with a name, a description, and a
  file list, browsable in one place.
- **Selective saves** — select 15 of your 80 changed files, right-click,
  "Save to Stash...". The rest of your working tree is untouched.
- **Restore with a safety net** — restore uses `apply`, never `pop`. The stash
  is only deleted after a clean apply, and a conflicted restore never
  auto-drops.

## Install

- **VS Code extension**: [Marketplace](https://marketplace.visualstudio.com/)
  and [Open VSX](https://open-vsx.org/) (search "StashBoard").
- **Local build (pre-release)**: download the `.vsix` from the latest
  [GitHub Release](https://github.com/Darkmintis/StashBoard/releases), then
  install it from VS Code's **Extensions → Install from VSIX…** or:
  ```bash
  code --install-extension stashboard-0.1.0.vsix
  ```
- **CLI**: `npm install -g @stashboard/cli`, then use `git stashboard ...`.

> On Windows, `git stashboard` resolves the extensionless `git-stashboard` shim
> npm installs. If your shell doesn't pick it up, add npm's global bin directory
> to `PATH`.

## Quick usage

### CLI

```bash
git stashboard add lib/auth/auth_service.dart lib/auth/login_page.dart --name "Auth Refactor"
git stashboard list
git stashboard show "Auth Refactor"
git stashboard restore "Auth Refactor"
git stashboard stage "Auth Refactor"          # restore straight into the index
git stashboard rename "Auth Refactor" "Auth Cleanup"
git stashboard drop "Auth Refactor"            # confirmation prompt unless --yes
```

### VS Code

- Right-click any file (or multi-selection) in the **Changes** list →
  **Save to Stash...** → type a name.
- Stashes appear in a **StashBoard** section in the Source Control sidebar,
  right below Git's own section.
- Right-click a stash to **Restore / Stage / Preview / Rename / Delete**.
- Expand a stash and click a file to open the native diff editor.
- The StashBoard input box lets you type a name and press Enter to save **all**
  current changes in one go.

### Stash Board (drag & drop panel)

The activity bar lists your stashes (like a folder tree). Open the board in the
editor with **StashBoard: Open Board** (or the window icon on the Stashes view).
Three drop columns:

- **Staged** — files staged in the index.
- **Changes** — unstaged and untracked working-tree files.
- **Stashes** — one card per stash, with Restore / Stage / Rename / Delete.

Drag a file card between columns (or between two stash cards) to move the
change — no menus required:

| Drag                                 | Result                              |
| ------------------------------------ | ----------------------------------- |
| Changes → Staged                     | `git add`                           |
| Staged → Changes                     | unstage                             |
| Changes → + New stash                | create a named stash from that file |
| Changes → an existing stash          | add that file into the stash        |
| Stash file → Changes / Staged        | restore that file                   |
| Stash → another stash                | move the file between stashes       |

Click **New stash** to park every current change under one name. Every operation
is transactional: the webview never mutates optimistically, so a rejected drop
snaps the card back with an inline error and the repo is left untouched.

## How it works / Is it safe?

StashBoard is a thin, transparent layer over `git stash`:

- **Storage**: one stash = one git stash entry, tagged `stashboard:<uuid>:<name>`.
  Stashes without that tag are never touched, shown, or modified.
- **Restore**: `git stash apply` first, and only after a clean apply is the
  stash dropped. On conflict, conflict markers are left (standard git
  behavior), the stash is **not** dropped, and you get explicit "Mark resolved
  & drop stash" / "Discard this restore attempt" actions.
- **Crash safety**: metadata lives in `.git/stashboard/metadata.json` and is
  only written after the underlying git operation is confirmed. On every
  activation the cache is reconciled with the real stash list — orphaned
  StashBoard stashes are adopted as "Recovered Stashes", dropped ones disappear.
- **Validation**: a file with both staged and unstaged changes is blocked
  before anything happens, with a clear message. A file with unresolved merge
  conflicts is blocked too.

## What StashBoard does NOT do (yet)

- Partial hunk selection — stashes are whole-file in v1.
- Stash → direct commit (restore to staged, then commit normally).
- Merging multiple stashes into one.
- Binary diff previews (shown as "binary file changed").
- Cloud sync, accounts, or telemetry — none, by design.

## Development

```
npm install
npm run build
npm test          # core unit+integration tests + CLI tests against real temp repos
```

### Releasing

```bash
# Bump version in packages/extension/package.json
npm run build && npm run typecheck && npm test
git tag v0.1.0
git push origin v0.1.0    # triggers the Release workflow → GitHub Release with .vsix
```

The release workflow checks that the tag matches the extension version, builds,
typechecks, tests, packages the `.vsix`, and attaches it to a GitHub Release.

Structure:

```
packages/
  core/        pure library — no VS Code dependencies (shared by CLI + GUI)
  cli/         the git-stashboard executable
  extension/   the VS Code extension
```

## License

MIT — see [LICENSE](LICENSE).

---

Made by [Darkmintis](https://darkmintis.dev).
