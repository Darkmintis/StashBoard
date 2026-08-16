import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runGit } from "../src";

export interface TempRepo {
  dir: string;
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  write: (rel: string, content: string) => string;
  read: (rel: string) => string;
  exists: (rel: string) => boolean;
  remove: () => void;
}

export async function makeRepo(): Promise<TempRepo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stashboard-test-"));
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test User"]);
  await runGit(dir, ["config", "commit.gpgsign", "false"]);
  // Keep working-tree line endings identical to the committed bytes across OSes.
  await runGit(dir, ["config", "core.autocrlf", "false"]);

  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  await runGit(dir, ["add", "."]);
  await runGit(dir, ["commit", "-m", "init"]);

  return {
    dir,
    run: (args) => runGit(dir, args),
    write: (rel, content) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      return abs;
    },
    read: (rel) => fs.readFileSync(path.join(dir, rel), "utf8"),
    exists: (rel) => fs.existsSync(path.join(dir, rel)),
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export async function stashListOutput(repo: TempRepo): Promise<string> {
  const { stdout } = await repo.run(["stash", "list"]);
  return stdout;
}
