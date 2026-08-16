import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const exec = promisify(execFile);
const CLI = path.resolve(__dirname, "../dist/git-stashboard.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(dir: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec("node", [CLI, ...args], { cwd: dir });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: dir });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stashboard-cli-test-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test User"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

test("cli add + list round trip", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "a2\n");
    const add = await runCli(dir, ["add", "a.txt", "--name", "First"]);
    assert.equal(add.code, 0, add.stderr);
    assert.ok(add.stdout.includes("First"));

    const list = await runCli(dir, ["list"]);
    assert.equal(list.code, 0);
    assert.ok(list.stdout.includes("First"));
    assert.ok(list.stdout.includes("1"), "file count column shows 1");
    assert.ok(list.stdout.includes("FILES"), "table header present");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli add requires a name", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "a2\n");
    const result = await runCli(dir, ["add", "a.txt"]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("name"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli blocks mixed staged+unstaged files", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "staged\n");
    await git(dir, ["add", "a.txt"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "staged + unstaged\n");
    const result = await runCli(dir, ["add", "a.txt", "--name", "Bad"]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.toLowerCase().includes("staged"));
    const stash = await git(dir, ["stash", "list"]);
    assert.equal(stash, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli restore brings files back and drops the stash", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "b.txt"), "b2\n");
    await runCli(dir, ["add", "b.txt", "--name", "Keep"]);
    assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "b\n");

    const restore = await runCli(dir, ["restore", "Keep"]);
    assert.equal(restore.code, 0, restore.stderr);
    assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "b2\n");

    const list = await runCli(dir, ["list"]);
    assert.ok(!list.stdout.includes("Keep"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli restore on conflict exits 2 and keeps the stash", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "stash\n");
    await runCli(dir, ["add", "a.txt", "--name", "C"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "committed\n");
    await git(dir, ["add", "a.txt"]);
    await git(dir, ["commit", "-m", "conflicting"]);

    const restore = await runCli(dir, ["restore", "C"]);
    assert.equal(restore.code, 2, restore.stderr);
    assert.ok(restore.stderr.includes("conflict"));

    const stash = await git(dir, ["stash", "list"]);
    assert.ok(stash.includes("C"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli show prints a diff", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "diff me\n");
    await runCli(dir, ["add", "a.txt", "--name", "Patch"]);
    const show = await runCli(dir, ["show", "Patch"]);
    assert.equal(show.code, 0);
    assert.ok(show.stdout.includes("diff --git"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli rename updates the stash name", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
    await runCli(dir, ["add", "a.txt", "--name", "Old"]);
    const rename = await runCli(dir, ["rename", "Old", "New"]);
    assert.equal(rename.code, 0, rename.stderr);
    const list = await runCli(dir, ["list"]);
    assert.ok(list.stdout.includes("New"));
    assert.ok(!list.stdout.includes("Old"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli drop with --yes deletes the stash", async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "y\n");
    await runCli(dir, ["add", "a.txt", "--name", "Doomed"]);
    const drop = await runCli(dir, ["drop", "Doomed", "--yes"]);
    assert.equal(drop.code, 0, drop.stderr);
    const stash = await git(dir, ["stash", "list"]);
    assert.equal(stash, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli errors outside a git repo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stashboard-cli-notrepo-"));
  try {
    const result = await runCli(dir, ["list"]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes("repository"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cli help lists commands", async () => {
  const result = await runCli(process.cwd(), ["help"]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("add"));
  assert.ok(result.stdout.includes("restore"));
});
