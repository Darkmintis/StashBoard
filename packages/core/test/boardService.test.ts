import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardConflictError, StashService } from "../src";
import { makeRepo, type TempRepo } from "./util";

function serviceFor(repo: TempRepo): StashService {
  return new StashService({ cwd: repo.dir });
}

async function stashFs(repo: TempRepo, ref: string): Promise<string[]> {
  const { stdout } = await repo.run(["stash", "show", "--name-status", "-u", ref]);
  return stdout
    .split("\n")
    .map((l) => l.replace(/^[AMDRC?]+\d*\s+/, "").trim())
    .filter((l) => l.length > 0);
}

test("boardStage stages an unstaged file (CHANGES -> STAGED)", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "edited\n");
    const service = serviceFor(repo);
    await service.boardStage("base.txt");
    const { stdout } = await repo.run(["diff", "--cached", "--name-only"]);
    assert.ok(stdout.includes("base.txt"));
  } finally {
    repo.remove();
  }
});

test("boardUnstage moves a staged file back to CHANGES", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "edited\n");
    const service = serviceFor(repo);
    await service.boardStage("base.txt");
    await service.boardUnstage("base.txt");
    const cached = await repo.run(["diff", "--cached", "--name-only"]);
    assert.equal(cached.stdout.trim(), "");
    const work = await repo.run(["diff", "--name-only"]);
    assert.ok(work.stdout.includes("base.txt"));
  } finally {
    repo.remove();
  }
});

test("boardAddToStash moves an unstaged change into an existing stash", async () => {
  const repo = await makeRepo();
  try {
    // Baseline stash holding one unrelated file.
    repo.write("other.txt", "other change\n");
    const service = serviceFor(repo);
    const stash = await service.save(["other.txt"], "Baseline");

    // New unstaged change elsewhere.
    repo.write("base.txt", "unstaged edit\n");
    await service.boardAddToStash(stash.name, "base.txt");

    const files = await stashFs(repo, stash.stashRef);
    assert.ok(files.includes("base.txt"));
    assert.ok(files.includes("other.txt"));
    // Working tree reverted for the moved file.
    assert.equal(repo.read("base.txt"), "base\n");
  } finally {
    repo.remove();
  }
});

test("boardAddToStash moves a staged change into an existing stash", async () => {
  const repo = await makeRepo();
  try {
    const service = serviceFor(repo);
    const stashName = await dummyStash(repo);

    repo.write("base.txt", "staged edit\n");
    await repo.run(["add", "base.txt"]);
    await service.boardAddToStash(stashName, "base.txt");

    // Stash now records the staged change; the index is clean again.
    assert.ok((await stashFs(repo, await refOf(repo, "Dummy"))).includes("base.txt"));
    const { stdout } = await repo.run(["diff", "--cached", "--name-only"]);
    assert.ok(!stdout.includes("base.txt"), "staged change reverted");
    assert.equal(repo.read("base.txt"), "base\n");
  } finally {
    repo.remove();
  }
});

test("boardAddToStash moves an untracked file into an existing stash", async () => {
  const repo = await makeRepo();
  try {
    const service = serviceFor(repo);
    const stashName = await dummyStash(repo);

    repo.write("notes.txt", "fresh untracked\n");
    await service.boardAddToStash(stashName, "notes.txt");

    assert.ok(
      (await stashFs(repo, await refOf(repo, "Dummy"))).includes("notes.txt")
    );
    assert.equal(repo.exists("notes.txt"), false, "untracked file moved into stash");
  } finally {
    repo.remove();
  }
});

test("boardRestoreFromStash restores a file to CHANGES and removes it from the stash", async () => {
  const repo = await makeRepo();
  try {
    const service = serviceFor(repo);
    repo.write("base.txt", "precious\n");
    const stash = await service.save(["base.txt"], "Keep Me");

    await service.boardRestoreFromStash(stash.name, "base.txt");

    assert.equal(repo.read("base.txt"), "precious\n");
    assert.ok(!(await stashFs(repo, stash.stashRef)).includes("base.txt"));
    const { stdout } = await repo.run(["diff", "--name-only"]);
    assert.ok(stdout.includes("base.txt"), "restored file is an unstaged change");
  } finally {
    repo.remove();
  }
});

test("boardRestoreFromStash with stage puts the file into the index", async () => {
  const repo = await makeRepo();
  try {
    const service = serviceFor(repo);
    repo.write("base.txt", "stage me\n");
    const stash = await service.save(["base.txt"], "Stage Me");

    await service.boardRestoreFromStash(stash.name, "base.txt", { stage: true });

    const { stdout } = await repo.run(["diff", "--cached", "--name-only"]);
    assert.ok(stdout.includes("base.txt"), "file staged after restore");
    assert.ok(!(await stashFs(repo, stash.stashRef)).includes("base.txt"));
  } finally {
    repo.remove();
  }
});

test("boardRestoreFromStash restores an untracked stash file", async () => {
  const repo = await makeRepo();
  try {
    const service = serviceFor(repo);
    repo.write("newfile.txt", "brand new\n");
    const stash = await service.save(["newfile.txt"], "New File");

    await service.boardRestoreFromStash(stash.name, "newfile.txt");
    assert.equal(repo.read("newfile.txt"), "brand new\n");
    assert.ok(!(await stashFs(repo, stash.stashRef)).includes("newfile.txt"));
  } finally {
    repo.remove();
  }
});

test("boardRestoreFromStash onto a dirty working tree is a conflict and touches nothing", async () => {
  const repo = await makeRepo();
  try {
    const service = serviceFor(repo);
    repo.write("base.txt", "stash version\n");
    const stash = await service.save(["base.txt"], "Conflict");

    // User has uncommitted work on the same file.
    repo.write("base.txt", "local version\n");

    await assert.rejects(
      service.boardRestoreFromStash(stash.name, "base.txt"),
      (err) => {
        assert.ok(err instanceof BoardConflictError);
        assert.equal(err.file, "base.txt");
        return true;
      }
    );
    // Stash untouched, working tree unchanged.
    assert.ok((await stashFs(repo, stash.stashRef)).includes("base.txt"));
    assert.equal(repo.read("base.txt"), "local version\n");
  } finally {
    repo.remove();
  }
});

test("boardMoveBetweenStashes moves a file between two stashes", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "move me\n");
    const service = serviceFor(repo);
    const source = await service.save(["base.txt"], "Source");

    repo.write("other.txt", "target content\n");
    const target = await service.save(["other.txt"], "Target");

    await service.boardMoveBetweenStashes(source.name, target.name, "base.txt");

    const sourceFiles = await stashFs(repo, await refOf(repo, "Source"));
    const targetFiles = await stashFs(repo, await refOf(repo, "Target"));
    assert.ok(!sourceFiles.includes("base.txt"), "removed from source stash");
    assert.ok(targetFiles.includes("base.txt"), "added to target stash");
    assert.ok(targetFiles.includes("other.txt"), "other file preserved");
  } finally {
    repo.remove();
  }
});

test("boardMoveBetweenStashes refuses when the target has a different version", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "source version\n");
    const service = serviceFor(repo);
    const source = await service.save(["base.txt"], "Source");

    // Target stash gets a different change for base.txt on its own.
    repo.write("base.txt", "reset\n");
    repo.write("sendme.txt", "x\n");
    const target = await service.save(["sendme.txt"], "Target");
    repo.write("base.txt", "target version\n");
    await service.boardAddToStash(target.name, "base.txt");

    await assert.rejects(
      service.boardMoveBetweenStashes(source.name, target.name, "base.txt"),
      (err) => err instanceof BoardConflictError
    );
    // Both stashes still hold their own version.
    assert.ok((await stashFs(repo, source.stashRef)).includes("base.txt"));
    assert.ok((await stashFs(repo, target.stashRef)).includes("base.txt"));
  } finally {
    repo.remove();
  }
});

test("boardView lists working-tree changes and per-stash files", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "edited\n");
    await serviceFor(repo).save(["base.txt"], "Stash One");
    repo.write("notes.txt", "untracked\n");

    const view = await serviceFor(repo).boardView();
    const paths = view.changes.map((c) => c.path).sort();
    assert.deepEqual(paths, ["notes.txt"], "saved change no longer in CHANGES");
    assert.equal(view.stashes.length, 1);
    assert.ok(view.stashes[0].files.some((f) => f.path === "base.txt"));
  } finally {
    repo.remove();
  }
});

// Helper: stash a throwaway file so the stash exists for later board ops.
async function dummyStash(repo: TempRepo): Promise<string> {
  repo.write("dummy.txt", "dummy\n");
  const stash = await serviceFor(repo).save(["dummy.txt"], "Dummy");
  return stash.name;
}

// Resolve the current git stash ref (`stash@{N}`) whose subject contains a name.
async function refOf(repo: TempRepo, name: string): Promise<string> {
  const { stdout } = await repo.run(["stash", "list", "--format=%gd%x00%gs"]);
  for (const line of stdout.split("\n")) {
    const nul = line.indexOf("\x00");
    if (nul === -1) continue;
    if (line.slice(nul + 1).includes(`:${name}`)) return line.slice(0, nul);
  }
  throw new Error(`stash named "${name}" not found`);
}