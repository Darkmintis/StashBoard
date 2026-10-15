import * as path from "node:path";
import * as vscode from "vscode";
import { StashService, isInsideRepo, stashFileEntries } from "@stashboard/core";
import { statusLetter, statusTooltip } from "./statusDecorations";

/** Activity-bar stash list (Apilot-style tree). The board itself lives in the editor panel. */
export class StashTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private disposables: vscode.Disposable[] = [];
  private service: StashService | undefined;
  private repoPath: string | undefined;

  static register(context: vscode.ExtensionContext): StashTree {
    const tree = new StashTree();
    const view = vscode.window.createTreeView("stashboard.stashes", {
      treeDataProvider: tree,
      showCollapseAll: true,
    });
    context.subscriptions.push(view, tree);
    return tree;
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(parent?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (parent instanceof StashItem) {
      return parent.files.map(
        (f) => new StashFileItem(parent.stashId, f.path, f.status, this.repoPath!)
      );
    }

    const repo = await this.resolveRepo();
    if (!repo) return [];
    this.repoPath = repo;
    this.service = new StashService({ cwd: repo });

    let stashes;
    try {
      stashes = await this.service.listStashes();
    } catch {
      return [];
    }

    if (stashes.length === 0) return [];

    const items: StashItem[] = [];
    for (const s of stashes) {
      let files: { path: string; status: string }[] = s.files.map((p) => ({
        path: p,
        status: "M",
      }));
      try {
        const ref = await this.service.getStashRef(s.id);
        const entries = await stashFileEntries({ cwd: repo, ref });
        const byPath = new Map<string, string>();
        for (const e of entries) byPath.set(e.path, e.status);
        files = [...byPath.entries()].map(([p, status]) => ({ path: p, status }));
      } catch {
        // keep fallback M
      }
      items.push(new StashItem(s.id, s.name, files, s.recovered === true));
    }
    return items;
  }

  private async resolveRepo(): Promise<string | undefined> {
    try {
      const ext = vscode.extensions.getExtension("vscode.git");
      const api = ext ? (ext.isActive ? ext.exports : await ext.activate()) : undefined;
      const gitApi = api?.getAPI?.(1);
      if (gitApi) {
        const active = vscode.window.activeTextEditor?.document.uri;
        if (active) {
          const repo = gitApi.getRepository(active);
          if (repo) return repo.rootUri.fsPath;
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          const repo = gitApi.getRepository(folder.uri);
          if (repo) return repo.rootUri.fsPath;
        }
        if (gitApi.repositories.length > 0) {
          return gitApi.repositories[0].rootUri.fsPath;
        }
      }
    } catch {
      // fall through
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        if (await isInsideRepo({ cwd: folder.uri.fsPath })) {
          return folder.uri.fsPath;
        }
      } catch {
        // not a repo
      }
    }
    return undefined;
  }
}

export class StashItem extends vscode.TreeItem {
  constructor(
    readonly stashId: string,
    name: string,
    readonly files: { path: string; status: string }[],
    recovered: boolean
  ) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = stashId;
    this.contextValue = "stashboardStash";
    this.description = `${files.length} file${files.length === 1 ? "" : "s"}`;
    this.tooltip = recovered ? `${name} (recovered)` : name;
    this.iconPath = new vscode.ThemeIcon("folder");
    this.command = {
      command: "stashboard.openBoard",
      title: "Open Board",
    };
  }
}

export class StashFileItem extends vscode.TreeItem {
  constructor(
    readonly stashId: string,
    readonly file: string,
    status: string,
    repoPath: string
  ) {
    super(path.basename(file), vscode.TreeItemCollapsibleState.None);
    const letter = statusLetter(status);
    const tip = statusTooltip(letter);
    const dir = path.dirname(file);
    this.description = dir === "." ? letter : `${letter}  ${dir}`;
    this.tooltip = `${tip} - ${file}`;
    this.resourceUri = vscode.Uri.file(path.join(repoPath, file));
    this.contextValue = "stashboardStashFile";
    this.iconPath = new vscode.ThemeIcon("file");
    this.command = {
      command: "stashboard.openFile",
      title: "Open Diff",
      arguments: [stashId, file],
    };
  }
}
