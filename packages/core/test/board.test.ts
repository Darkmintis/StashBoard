import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeStash,
  resolveStashAnatomy,
  type StashAnatomy,
  type EntryUpdate,
} from "../src/board";
import { runGit } from "../src";
import { type GitOpts } from "../src/stashOps";
import { makeRepo, type TempRepo } from "./util";

function optsFor(repo: TempRepo): GitOpts {
  return { cwd: repo.dir };
}

async function makeStash(
  repo: TempRepo,
  message: string,
  includeUntracked = true
): Promise<void> {
  const args = ["stash", "push"];
  if (includeUntracked) args.push("-u");
  args.push("-m", message);
  await repo.run(args);
}

async function topRef(repo: TempRepo): Promise<string> {
  const { stdout } = await repo.run(["stash", "list", "--format=%gd"]);
  return stdout.trim().split("\n")[0] ?? "stash@{0}";
}

async function rev(repo: TempRepo, expr: string): Promise<string> {
  const { stdout } = await repo.run(["rev-parse", expr]);
  return stdout.trim();
}

/** Read the sha of path inside a commit's tree. */
async function treeEntrySha(
  repo: TempRepo,
  treeExpr: string,
  path: string
): Promise<string | null> {
  const { stdout, code } = await repo.run(["ls-tree", treeExpr, "--", path]);
  if (code !== 0 || !stdout.trim()) return null;
  const m = /blob\s+([0-9a-f]{40,64})\s/.exec(stdout);
  return m ? m[1] : null;
}

test("resolveStashAnatomy reads all four layers of a -u stash", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "modified\n");
    repo.write("newfile.txt", "untracked content\n");
    await makeStash(repo, "test stash");

    const a = await resolveStashAnatomy(optsFor(repo), await topRef(repo));
    assert.match(a.message, /test stash/);
    assert.ok(a.base.length === 40, "W^1 resolved");
    assert.ok(a.indexCommit !== null, "W^2 exists");
    assert.ok(a.untrackedCommit !== null, "W^3 exists for -u stash");
    assert.notEqual(a.worktree, a.indexTree, "W tree differs from W^2 tree");

    // W^2's tree should mirror HEAD (index was clean before the stash).
    assert.equal(a.indexTree, await rev(repo, "HEAD^{tree}"));
    // W^3's tree only holds the untracked file.
    assert.ok((await treeEntrySha(repo, a.untrackedTree!, "newfile.txt")) !== null);
    assert.equal((await treeEntrySha(repo, a.untrackedTree!, "base.txt")), null);
  } finally {
    repo.remove();
  }
});

test("composeStash adds an untracked file into an existing 3-parent stash", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "modified\n");
    await makeStash(repo, "original stash");

    // Working tree now clean; create a new untracked file to fold in.
    repo.write("notes.txt", "fresh untracked\n");

    const opts = optsFor(repo);
    const ref = await topRef(repo);
    const anatomy = await resolveStashAnatomy(opts, ref);
    const entry: EntryUpdate = {
      mode: "100644",
      sha: (
        await runGit(repo.dir, ["hash-object", "-w", "--", "notes.txt"])
      ).stdout.trim(),
    };

    const compose = {
      anatomy,
      worktree: new Map<string, EntryUpdate | null>(),
      index: new Map<string, EntryUpdate | null>(),
      untracked: new Map<string, EntryUpdate | null>([["notes.txt", entry]]),
    };
    const result = await composeStash(opts, compose);
    assert.ok(result.sha.length === 40);

    // New stash still lists against original message and has both files.
    const { stdout } = await repo.run(["stash", "list"]);
    assert.ok(stdout.includes("original stash"), stdout);
    const files = await repo.run(["stash", "show", "--name-status", "-u", result.sha]);
    assert.ok(files.stdout.includes("notes.txt"));
    assert.ok(files.stdout.includes("base.txt"));
  } finally {
    repo.remove();
  }
});

test("composeStash removes a file from the stash", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "modified\n");
    repo.write("newfile.txt", "untracked content\n");
    await makeStash(repo, "original stash");

    const opts = optsFor(repo);
    const ref = await topRef(repo);
    const anatomy = await resolveStashAnatomy(opts, ref);

    const compose = {
      anatomy,
      worktree: new Map<string, EntryUpdate | null>(),
      index: new Map<string, EntryUpdate | null>(),
      untracked: new Map<string, EntryUpdate | null>([["newfile.txt", null]]),
    };

    // Removing the only untracked file collapses the stash back to 2 parents.
    const result = await composeStash(opts, compose);
    assert.ok(result.untrackedChanged);

    const reResolved = await resolveStashAnatomy(opts, ref);
    assert.equal(reResolved.untrackedCommit, null, "W^3 should be gone");
    assert.equal(
      await treeEntrySha(repo, reResolved.worktree, "newfile.txt"),
      null
    );
  } finally {
    repo.remove();
  }
});

test("composeStash removes a tracked modified file and shows it via stashFiles", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "only unstaged change\n");
    await makeStash(repo, "unstaged stash", false);
    assert.ok((await repo.run(["stash", "list"])).stdout.length > 0);

    const opts = optsFor(repo);
    const ref = await topRef(repo);
    const anatomy = await resolveStashAnatomy(opts, ref);
    assert.equal(anatomy.untrackedCommit, null, "no untracked in this stash");

    // Removal of a tracked file means: its W and W^2 entries go back to base,
    // so the stash records no change for the path (delete the path only when it
    // did not exist at base).
    const baseEntrySha = await treeEntrySha(repo, "HEAD^{tree}", "base.txt");
    assert.ok(baseEntrySha !== null);

    const compose = {
      anatomy,
      worktree: new Map<string, EntryUpdate | null>([
        ["base.txt", { mode: "100644", sha: baseEntrySha! }],
      ]),
      index: new Map<string, EntryUpdate | null>(),
      untracked: new Map<string, EntryUpdate | null>(),
    };
    const result = await composeStash(opts, compose);

    const files = await repo.run(["stash", "show", "--name-status", "-u", result.sha]);
    assert.ok(!files.stdout.includes("base.txt"), "file removed from stash show");
    const { stdout } = await repo.run(["stash", "list"]);
    assert.ok(stdout.includes("unstaged stash"), "message preserved after swap");
  } finally {
    repo.remove();
  }
});

test("swapStash replacement is findable by git stash apply", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "modified\n");
    await makeStash(repo, "apply me");

    const opts = optsFor(repo);
    const ref = await topRef(repo);
    const anatomy = await resolveStashAnatomy(opts, ref);

    // No-op change (recompose identical trees) to exercise the full swap.
    const compose = {
      anatomy,
      worktree: new Map<string, EntryUpdate | null>(),
      index: new Map<string, EntryUpdate | null>(),
      untracked: new Map<string, EntryUpdate | null>(),
    };
    const result = await composeStash(opts, compose);

    // Recreating the stash commit with identical trees should yield identical
    // commit? No — author/committer dates drift, so a new sha is expected, but
    // applying it must reproduce the same working content.
    await repo.run(["stash", "apply", result.sha]);
    assert.equal(repo.read("base.txt"), "modified\n");
    assert.equal(repo.read("base.txt"), "modified\n");
  } finally {
    repo.remove();
  }
});