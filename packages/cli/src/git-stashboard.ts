#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  StashboardError,
  RestoreConflictError,
  StashNotFoundError,
  StashService,
  isInsideRepo,
} from "@stashboard/core";

const VERSION = "0.1.0";

const isTTY = Boolean(process.stdout.isTTY);

function color(code: string, text: string): string {
  return isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}
const dim = (t: string) => color("2", t);
const green = (t: string) => color("32", t);
const red = (t: string) => color("31", t);
const yellow = (t: string) => color("33", t);
const cyan = (t: string) => color("36", t);

const HELP = `git-stashboard ${VERSION} — named, safe stashes for unfinished git work.

Usage: git stashboard <command> [options]

Commands:
  add <file...> --name <name> [--staged]
      Save the selected files into a new named stash.
  list
      List all stashes. Aliases: ls
  show <name-or-id> [--file <path>]
      Print the diff of a stash (or a single file within it).
  restore <name-or-id>
      Restore a stash's changes into the working tree.
  stage <name-or-id>
      Restore a stash's changes directly into the staged area.
  rename <name-or-id> <new-name>
      Rename a stash.
  drop <name-or-id> [--yes]
      Delete a stash. Confirmation required unless --yes.
  help
      Show this help.
  version
      Print the version.

Every StashBoard stash is a real git stash entry — inspect any of them any time
with plain "git stash list". Nothing proprietary.
`;

function usageError(message: string): never {
  process.stderr.write(red(`error: ${message}\n`));
  process.stderr.write(dim("Run `git stashboard help` for usage.\n"));
  process.exit(1);
}

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      for (const rest of argv.slice(i + 1)) positionals.push(rest);
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const name = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function flagValue(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}
function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || flagValue(args, name) === "true";
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${yellow(prompt)} ${dim("[y/N]")} `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function pad(value: string, width: number): string {
  const v = String(value);
  return v.length >= width ? v : v + " ".repeat(width - v.length);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function printTable(service: StashService): Promise<void> {
  const stashes = await service.listStashes();
  if (stashes.length === 0) {
    process.stdout.write(dim("No stashes yet. Use `git stashboard add <files> --name \"<name>\"`.\n"));
    return;
  }
  const nameW = Math.max(4, ...stashes.map((s) => s.name.length)) + 2;
  process.stdout.write(
    `${pad("NAME", nameW)}${pad("ID", 10)}${pad("FILES", 7)}${pad("AGE", 9)}BRANCH\n`
  );
  for (const s of stashes) {
    const recovered = s.recovered ? yellow(" (recovered)") : "";
    process.stdout.write(
      `${pad(s.name, nameW)}${pad(shortId(s.id), 10)}${pad(String(s.files.length), 7)}${pad(formatAge(s.createdAt), 9)}${s.branch || dim("—")}${recovered}\n`
    );
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const [rawCommand, ...rest] = argv;
  const command = rawCommand.toLowerCase();
  if (command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "version" || command === "-v" || command === "--version") {
    process.stdout.write(`git-stashboard ${VERSION}\n`);
    return 0;
  }

  const cwd = process.cwd();
  if (!(await isInsideRepo({ cwd }))) {
    process.stderr.write(red("error: not inside a git repository.\n"));
    return 1;
  }
  const service = new StashService({ cwd });

  try {
    switch (command) {
      case "add": {
        const args = parseArgs(rest);
        const name = flagValue(args, "name") ?? flagValue(args, "n");
        if (!name) usageError("add requires --name <name>");
        if (args.positionals.length === 0)
          usageError("add requires at least one file path");
        const stash = await service.save(args.positionals, name, {
          stagedOnly: flagBool(args, "staged"),
        });
        process.stdout.write(
          green(`Saved ${cyan(`"${stash.name}"`)} (${stash.files.length} file${stash.files.length === 1 ? "" : "s"}) to ${dim(stash.stashRef)}.\n`)
        );
        return 0;
      }

      case "list":
      case "ls": {
        const args = parseArgs(rest);
        if (args.positionals.length > 0)
          usageError("list takes no arguments");
        await printTable(service);
        return 0;
      }

      case "show": {
        const args = parseArgs(rest);
        const target = args.positionals[0];
        if (!target) usageError("show requires <name-or-id>");
        const file = flagValue(args, "file");
        const stash = await service.resolvePublicStash(target);
        const patch = file
          ? await service.previewFile(stash, file)
          : await service.preview(target);
        process.stdout.write(patch);
        return 0;
      }

      case "restore": {
        const args = parseArgs(rest);
        const target = args.positionals[0];
        if (!target) usageError("restore requires <name-or-id>");
        const result = await service.restore(target);
        process.stdout.write(
          green(`Restored ${cyan(`"${target}"`)} — ${result.files.length} file${result.files.length === 1 ? "" : "s"} back in the working tree.\n`)
        );
        return 0;
      }

      case "stage": {
        const args = parseArgs(rest);
        const target = args.positionals[0];
        if (!target) usageError("stage requires <name-or-id>");
        const result = await service.stage(target);
        process.stdout.write(
          green(`Staged ${cyan(`"${target}"`)} — ${result.files.length} file${result.files.length === 1 ? "" : "s"}.\n`)
        );
        return 0;
      }

      case "rename": {
        const args = parseArgs(rest);
        const target = args.positionals[0];
        const newName = args.positionals[1];
        if (!target || !newName) usageError("rename requires <name-or-id> <new-name>");
        const stash = await service.rename(target, newName);
        process.stdout.write(green(`Renamed ${cyan(`"${target}"`)} → ${cyan(`"${stash.name}"`)}.\n`));
        return 0;
      }

      case "drop":
      case "rm": {
        const args = parseArgs(rest);
        const target = args.positionals[0];
        if (!target) usageError("drop requires <name-or-id>");
        if (!flagBool(args, "yes") && !flagBool(args, "y")) {
          const ok = await confirm(`Drop stash "${target}"? This permanently deletes it.`);
          if (!ok) {
            process.stdout.write(dim("Cancelled.\n"));
            return 0;
          }
        }
        await service.delete(target);
        process.stdout.write(green(`Dropped ${cyan(`"${target}"`)}.\n`));
        return 0;
      }

      default:
        process.stderr.write(red(`error: unknown command "${rawCommand}".\n`));
        process.stderr.write(dim("Run `git stashboard help` for usage.\n"));
        return 1;
    }
  } catch (err) {
    if (err instanceof RestoreConflictError) {
      process.stderr.write(red(err.message + "\n"));
      process.stderr.write(
        yellow(
          "The stash was NOT dropped. Resolve the conflict markers, then run:\n" +
            `  git stashboard restore ${rest[0] ?? ""}    # after resolving\n`
        )
      );
      return 2;
    }
    if (err instanceof StashNotFoundError || err instanceof StashboardError) {
      process.stderr.write(red(`error: ${err.message}\n`));
      return 1;
    }
    process.stderr.write(red(`error: ${(err as Error).message ?? err}\n`));
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(red(`fatal: ${(err as Error).message}\n`));
    process.exit(1);
  }
);
