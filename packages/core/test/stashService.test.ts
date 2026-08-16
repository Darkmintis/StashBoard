import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MixedStateError,
  RestoreConflictError,
  StashNotFoundError,
  StashService,
  metadataPath,
  readMetadata,
} from "../src";
import { makeRepo, type TempRepo } from "./util";

function serviceFor(repo: TempRepo): StashService {
  return new StashService({ cwd: repo.dir });
}

async function gitStashList(repo: TempRepo): Promise<string> {
  const { stdout } = await repo.run(["stash", "list"]);
  return stdout;
}

test("save moves selected files into a named stash + metadata", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "base\nchanged\n");
    const service = serviceFor(repo);
    const stash = await service.save(["base.txt"], "Auth Refactor");

    assert.equal(stash.name, "Auth Refactor");
    assert.equal(stash.files.length, 1);
    assert.ok(stash.id.length > 0);

    const list = await gitStashList(repo);
    assert.ok(list.includes(stash.id), `stash message should contain id: ${list}`);

    // Working tree reverted to committed state.
    assert.equal(repo.read("base.txt"), "base\n");
  } finally {
    repo.remove();
  }
});

// Helper to get the common git dir path for metadata assertions.
async function repoCommon(repo: TempRepo): Promise<string> {
  const { stdout } = await repo.run(["rev-parse", "--git-common-dir"]);
  const out = stdout.trim();
  return out.startsWith("/") || /^[A-Za-z]:[\\/]/.test(out) ? out : `${repo.dir}/${out}`;
}

test("metadata is written after a successful save", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "hello\n");
    await serviceFor(repo).save(["base.txt"], "First");
    const common = await repoCommon(repo);
    const meta = readMetadata(common);
    assert.equal(meta.stashes.length, 1);
    assert.equal(meta.stashes[0].name, "First");
    assert.ok(repo.exists("base.txt"));
  } finally {
    repo.remove();
  }
});

test("save supports untracked files", async () => {
  const repo = await makeRepo();
  try {
    repo.write("notes.txt", "brand new\n");
    const stash = await serviceFor(repo).save(["notes.txt"], "Notes");
    assert.equal(stash.includesUntracked, true);
    assert.equal(repo.exists("notes.txt"), false, "untracked file removed from working tree");
  } finally {
    repo.remove();
  }
});

test("save blocks mixed staged+unstaged files and touches nothing", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "v1\n");
    await repo.run(["add", "base.txt"]);
    repo.write("base.txt", "v1\nv2\n");

    await assert.rejects(
      serviceFor(repo).save(["base.txt"], "Bad"),
      (err) => err instanceof MixedStateError
    );
    assert.equal(await gitStashList(repo), "", "no stash should be created");
    assert.equal(repo.read("base.txt"), "v1\nv2\n", "working tree untouched");
  } finally {
    repo.remove();
  }
});

test("save with stagedOnly stashes staged-only files", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "staged content\n");
    await repo.run(["add", "base.txt"]);
    const stash = await serviceFor(repo).save(["base.txt"], "Staged", {
      stagedOnly: true,
    });
    assert.equal(stash.files.length, 1);
    assert.equal(repo.read("base.txt"), "base\n", "file reset to HEAD");
  } finally {
    repo.remove();
  }
});

test("save requires a name", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "x\n");
    await assert.rejects(serviceFor(repo).save(["base.txt"], "  "));
    await assert.rejects(serviceFor(repo).save(["base.txt"], ""));
  } finally {
    repo.remove();
  }
});

test("save requires files with changes", async () => {
  const repo = await makeRepo();
  try {
    await assert.rejects(serviceFor(repo).save(["base.txt"], "Nothing"));
  } finally {
    repo.remove();
  }
});

test("list stashes returns saved stashes", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "one\n");
    await serviceFor(repo).save(["base.txt"], "Stash One");
    repo.write("base.txt", "two\n");
    await serviceFor(repo).save(["base.txt"], "Stash Two");
    const stashes = await serviceFor(repo).listStashes();
    assert.equal(stashes.length, 2);
    const names = stashes.map((s) => s.name).sort();
    assert.deepEqual(names, ["Stash One", "Stash Two"]);
  } finally {
    repo.remove();
  }
});

test("restore brings changes back and drops the stash on clean success", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "precious work\n");
    const stash = await serviceFor(repo).save(["base.txt"], "Precious");
    assert.equal(repo.read("base.txt"), "base\n");

    const result = await serviceFor(repo).restore(stash.name);
    assert.equal(result.status, "restored");
    assert.equal(repo.read("base.txt"), "precious work\n");
    assert.equal(await gitStashList(repo), "", "stash dropped after clean restore");

    const common = await repoCommon(repo);
    assert.equal(readMetadata(common).stashes.length, 0, "metadata pruned");
  } finally {
    repo.remove();
  }
});

test("stage restores files directly into the index", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "to be staged\n");
    await serviceFor(repo).save(["base.txt"], "StageMe");
    const result = await serviceFor(repo).stage("StageMe");
    assert.equal(result.status, "staged");
    const { stdout } = await repo.run(["diff", "--cached", "--name-only"]);
    assert.ok(stdout.includes("base.txt"));
    assert.equal(await gitStashList(repo), "");
  } finally {
    repo.remove();
  }
});

test("restore into a conflicting working tree keeps the stash and reports conflicts", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "stash version\n");
    const stash = await serviceFor(repo).save(["base.txt"], "ConflictTest");
    // Commit a conflicting change on top of the stash's base commit.
    repo.write("base.txt", "committed version\n");
    await repo.run(["add", "base.txt"]);
    await repo.run(["commit", "-m", "conflicting change"]);

    await assert.rejects(
      serviceFor(repo).restore(stash.name),
      (err) => {
        assert.ok(err instanceof RestoreConflictError);
        assert.ok(err.conflictFiles.includes("base.txt"));
        return true;
      }
    );

    // Stash must still exist after the conflict.
    const list = await gitStashList(repo);
    assert.ok(list.includes(stash.id), "stash kept after conflict");
    const { stdout } = await repo.run(["status", "--porcelain"]);
    assert.ok(stdout.includes("UU"), `expected unmerged state, got:\n${stdout}`);
  } finally {
    repo.remove();
  }
});

test("discardRestoreAttempt reverts conflict markers and keeps the stash", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "stash version\n");
    const stash = await serviceFor(repo).save(["base.txt"], "DiscardMe");
    repo.write("base.txt", "committed version\n");
    await repo.run(["add", "base.txt"]);
    await repo.run(["commit", "-m", "conflicting change"]);

    await assert.rejects(serviceFor(repo).restore(stash.name));
    await serviceFor(repo).discardRestoreAttempt(stash.name, ["base.txt"]);

    // Conflict markers gone; working tree reverted to the committed state.
    assert.equal(repo.read("base.txt"), "committed version\n");
    const list = await gitStashList(repo);
    assert.ok(list.includes(stash.id), "stash intact after discard");
    const { stdout } = await repo.run(["status", "--porcelain"]);
    assert.ok(!stdout.includes("UU"), `no unmerged state expected, got:\n${stdout}`);
  } finally {
    repo.remove();
  }
});

test("rename rewrites the stash message and metadata", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "data\n");
    const stash = await serviceFor(repo).save(["base.txt"], "Old Name");
    const renamed = await serviceFor(repo).rename(stash.name, "New Name");
    assert.equal(renamed.name, "New Name");
    assert.equal(renamed.id, stash.id, "id preserved across rename");

    const list = await gitStashList(repo);
    assert.ok(list.includes(stash.id), "stash still contains our id");
    assert.ok(list.includes("New Name"), "message updated");
    assert.ok(!list.includes("Old Name"), "old name gone");

    const common = await repoCommon(repo);
    const meta = readMetadata(common);
    assert.equal(meta.stashes.length, 1);
    assert.equal(meta.stashes[0].name, "New Name");
  } finally {
    repo.remove();
  }
});

test("delete drops the stash and prunes metadata", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "data\n");
    const stash = await serviceFor(repo).save(["base.txt"], "Doomed");
    await serviceFor(repo).delete(stash.name);
    assert.equal(await gitStashList(repo), "");
    const common = await repoCommon(repo);
    assert.equal(readMetadata(common).stashes.length, 0);
  } finally {
    repo.remove();
  }
});

test("reconcile prunes stashes whose git stash was dropped manually", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "data\n");
    const stash = await serviceFor(repo).save(["base.txt"], "Gone Soon");
    await repo.run(["stash", "drop"]);
    const service = serviceFor(repo);
    const result = await service.reconcile();
    assert.equal(result.pruned, 1);
    const common = await repoCommon(repo);
    assert.equal(readMetadata(common).stashes.length, 0);
  } finally {
    repo.remove();
  }
});

test("reconcile adopts orphaned stashboard stashes as recovered stashes", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "orphan content\n");
    await repo.run([
      "stash", "push", "-m", "stashboard:aaaaaaaa-1111-2222-3333-444444444444:Orphan Work",
      "--", "base.txt",
    ]);
    const service = serviceFor(repo);
    const result = await service.reconcile();
    assert.equal(result.adopted, 1);
    const stashes = await service.listStashes();
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].name, "Orphan Work");
    assert.equal(stashes[0].recovered, true);
    assert.deepEqual(stashes[0].files, ["base.txt"]);
  } finally {
    repo.remove();
  }
});

test("resolvePublicStash throws for unknown stashes", async () => {
  const repo = await makeRepo();
  try {
    await assert.rejects(serviceFor(repo).resolvePublicStash("nope"), StashNotFoundError);
  } finally {
    repo.remove();
  }
});

test("preview returns a patch for the stash", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "patchable\n");
    const stash = await serviceFor(repo).save(["base.txt"], "Patch Me");
    const patch = await serviceFor(repo).preview(stash.name);
    assert.ok(patch.includes("diff --git"), "patch should contain a diff header");
    assert.ok(patch.includes("base.txt"));
  } finally {
    repo.remove();
  }
});

test("metadata survives a full stash lifecycle without corruption", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "one\n");
    const service = serviceFor(repo);
    await service.save(["base.txt"], "Alpha");
    repo.write("base.txt", "two\n");
    await service.save(["base.txt"], "Beta");
    const common = await repoCommon(repo);
    const meta = readMetadata(common);
    assert.equal(meta.stashes.length, 2);
    assert.ok(metadataPath(common).endsWith("metadata.json"));
  } finally {
    repo.remove();
  }
});