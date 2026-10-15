import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUnmergedCode,
  parseGitVersion,
  parseNameStatusEntriesZ,
  parseNameStatusZ,
} from "../src/stashOps";
import { isStashboardSubject } from "../src/git";
import { parseStashSubject } from "../src/stashService";

test("parseGitVersion handles common formats", () => {
  assert.deepEqual(parseGitVersion("git version 2.39.1.windows.1"), {
    major: 2,
    minor: 39,
    patch: 1,
  });
  assert.deepEqual(parseGitVersion("git version 2.35.0"), { major: 2, minor: 35, patch: 0 });
  assert.deepEqual(parseGitVersion("git version 2.40"), { major: 2, minor: 40, patch: 0 });
});

test("parseNameStatusZ extracts paths including renames", () => {
  // `-z` format: STATUS\0path\0 (renames: R100\0old\0new\0).
  const out =
    "M\x00lib/foo.dart\x00D\x00old.txt\x00R100\x00old/name.ts\x00new/name.ts\x00A\x00u.txt\x00";
  const paths = parseNameStatusZ(out);
  assert.deepEqual(paths, [
    "lib/foo.dart",
    "old.txt",
    "old/name.ts",
    "new/name.ts",
    "u.txt",
  ]);
});

test("parseNameStatusZ handles empty output", () => {
  assert.deepEqual(parseNameStatusZ(""), []);
});

test("parseNameStatusEntriesZ keeps status letters", () => {
  const out = "M\x00a.ts\x00A\x00b.ts\x00??\x00c.ts\x00D\x00gone.ts\x00";
  assert.deepEqual(parseNameStatusEntriesZ(out), [
    { path: "a.ts", status: "M" },
    { path: "b.ts", status: "A" },
    { path: "c.ts", status: "U" },
    { path: "gone.ts", status: "D" },
  ]);
});

test("parseStashSubject extracts id, name and branch", () => {
  const parsed = parseStashSubject("On feature/login: stashboard:12345678-1234-1234-1234-123456789abc:Auth Refactor");
  assert.ok(parsed);
  assert.equal(parsed!.id, "12345678-1234-1234-1234-123456789abc");
  assert.equal(parsed!.name, "Auth Refactor");
  assert.equal(parsed!.branch, "feature/login");
});

test("parseStashSubject handles store-created subjects (no On prefix)", () => {
  const parsed = parseStashSubject("stashboard:12345678-1234-1234-1234-123456789abc:UI Experiment");
  assert.ok(parsed);
  assert.equal(parsed!.name, "UI Experiment");
  assert.equal(parsed!.branch, undefined);
});

test("parseStashSubject preserves colons inside the name", () => {
  const parsed = parseStashSubject("stashboard:12345678-1234-1234-1234-123456789abc:fix: auth bug");
  assert.ok(parsed);
  assert.equal(parsed!.name, "fix: auth bug");
});

test("parseStashSubject rejects non-stashboard messages", () => {
  assert.equal(parseStashSubject("WIP on main: stuff"), null);
  assert.equal(parseStashSubject(""), null);
});

test("parseStashSubject rejects malformed stashboard messages", () => {
  assert.equal(parseStashSubject("stashboard:missing-name-separator"), null);
  assert.equal(parseStashSubject("stashboard::"), null);
});

test("isUnmergedCode identifies conflict statuses only", () => {
  for (const code of ["UU", "AA", "DD", "AU", "UA", "DU", "UD"]) {
    assert.equal(isUnmergedCode(code), true, code);
  }
  for (const code of ["M ", " M", "MM", "??", "R ", " D"]) {
    assert.equal(isUnmergedCode(code), false, code);
  }
});

test("isStashboardSubject detects stashboard tags", () => {
  assert.equal(isStashboardSubject("WIP on main: stashboard:abc-123:My Stash"), true);
  assert.equal(isStashboardSubject("stashboard:abc-123:My Stash"), true);
  assert.equal(isStashboardSubject("WIP on main: stuff"), false);
  assert.equal(isStashboardSubject(""), false);
  assert.equal(isStashboardSubject("stash@{0}"), false);
});
