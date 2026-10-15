# StashBoard

Named, safe stashes for unfinished git work. Every stash is a real `git stash`
entry — inspectable any time with `git stash list`.

## What you get

- **Stash Board** — drag-and-drop panel (sidebar + full editor). Park files in
  named stashes, stage/unstage, restore one file or a whole stash.
- **Source Control** — a StashBoard section under Git. Right-click files in
  Changes → **Save to Stash...**. Restore / stage / preview / rename / delete
  from each stash group.
- **Safe restore** — `apply` then drop. Conflicts never auto-drop the stash.

## Quick start

1. Open a git workspace.
2. Click the StashBoard icon in the activity bar, or run **StashBoard: Open Board**.
3. Drag a changed file onto **+ New stash**, name it, done.
4. Drag files between **Staged**, **Changes**, and stash cards to move work.

| Drag | Result |
| --- | --- |
| Changes → Staged | `git add` |
| Staged → Changes | unstage |
| Changes → + New / a stash | create or grow a stash |
| Stash file → Changes / Staged | restore that file |
| Stash → another stash | move the file |

## Commands

- `StashBoard: Open Board` — full editor panel
- `StashBoard: Save Selected Files to Stash...`
- `StashBoard: Save All Changes to Stash`
- `StashBoard: Restore / Stage / Preview / Rename / Delete`

Full docs and the CLI (`git stashboard`) live at the repository root:
https://github.com/Darkmintis/StashBoard
