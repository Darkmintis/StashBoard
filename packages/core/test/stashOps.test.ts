import { test } from "node:test";
import assert from "node:assert/strict";
import { stashShowPatch, stashList } from "../src/stashOps";
import { StashService } from "../src/stashService";
import { makeRepo, type TempRepo } from "./util";

function serviceFor(repo: TempRepo): StashService {
  return new StashService({ cwd: repo.dir });
}

/** Resolve `stash@{0}` (the newest stash) to a stable ref string. */
async function topStashRef(repo: TempRepo): Promise<string> {
  const entries = await stashList({ cwd: repo.dir });
  assert.ok(entries.length > 0, "expected at least one stash");
  return entries[0].ref;
}

test("stashShowPatch full preview includes all changed files", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "tracked change\n");
    await serviceFor(repo).save(["base.txt"], "Tracked");

    const ref = await topStashRef(repo);
    const patch = await stashShowPatch({ cwd: repo.dir, ref });

    assert.ok(patch.includes("diff --git"), "patch should contain diff headers");
    assert.ok(patch.includes("base.txt"), "patch should mention the tracked file");
    assert.equal(patch.length > 0, true, "patch should be non-empty");
  } finally {
    repo.remove();
  }
});

test("stashShowPatch with file returns a scoped diff for a tracked file", async () => {
  const repo = await makeRepo();
  try {
    // base.txt is tracked (committed "base\n"); modify it.
    repo.write("base.txt", "tracked change\n");
    // Also create an untracked file so we can verify it doesn't leak.
    repo.write("notes.txt", "should not appear\n");
    await serviceFor(repo).save(["base.txt", "notes.txt"], "Two Files");

    const ref = await topStashRef(repo);
    const patch = await stashShowPatch({ cwd: repo.dir, ref, file: "base.txt" });

    assert.ok(patch.includes("diff --git"), "patch should contain a diff header");
    assert.ok(patch.includes("base.txt"), "patch should mention the requested file");
    assert.ok(!patch.includes("notes.txt"), "patch should NOT mention the other file");
    assert.ok(patch.includes("tracked change"), "patch should contain the file's content");
  } finally {
    repo.remove();
  }
});

test("stashShowPatch with file returns a diff for an untracked file", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "tracked change\n");
    repo.write("notes.txt", "untracked content\n");
    await serviceFor(repo).save(["base.txt", "notes.txt"], "With Untracked");

    const ref = await topStashRef(repo);
    const patch = await stashShowPatch({ cwd: repo.dir, ref, file: "notes.txt" });

    assert.ok(patch.includes("diff --git"), "patch should contain a diff header");
    assert.ok(patch.includes("notes.txt"), "patch should mention the untracked file");
    assert.ok(patch.includes("untracked content"), "patch should contain the file's content");
    assert.ok(!patch.includes("base.txt"), "patch should NOT mention the tracked file");
  } finally {
    repo.remove();
  }
});

test("stashShowPatch for a file not in the stash returns empty", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "tracked change\n");
    await serviceFor(repo).save(["base.txt"], "One File");

    const ref = await topStashRef(repo);
    const patch = await stashShowPatch({ cwd: repo.dir, ref, file: "does-not-exist.txt" });

    assert.equal(patch, "", "should be empty for a file not in the stash");
  } finally {
    repo.remove();
  }
});

test("stashShowPatch with file works for a stash with no untracked files", async () => {
  const repo = await makeRepo();
  try {
    repo.write("base.txt", "tracked change\n");
    await serviceFor(repo).save(["base.txt"], "Tracked Only");

    const ref = await topStashRef(repo);
    const patch = await stashShowPatch({ cwd: repo.dir, ref, file: "base.txt" });

    assert.ok(patch.includes("base.txt"), "patch should mention the file");
    assert.ok(patch.includes("tracked change"), "patch should contain the content");
  } finally {
    repo.remove();
  }
});
