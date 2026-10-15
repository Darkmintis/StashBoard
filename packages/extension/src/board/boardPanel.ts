import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  BoardConflictError,
  MixedStateError,
  RestoreConflictError,
  StashService,
  StashboardError,
  classifyPath,
  collectWorkingTreeState,
  isInsideRepo,
  type BoardView,
} from "@stashboard/core";
import { fileDiffUri } from "../stashContentProvider";

const VIEW_TYPE = "stashboard.board";
const PANEL_TYPE = "stashboard.boardPanel";

/**
 * Stash Board — activity-bar webview + full editor panel (Apilot-style).
 * The webview never mutates optimistically; it only renders state we post back.
 */
export class BoardPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  static viewType = VIEW_TYPE;

  private disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private service: StashService | undefined;
  private repoPath: string | undefined;
  private busy = false;
  private log = vscode.window.createOutputChannel("StashBoard Board");

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): BoardPanel {
    const board = new BoardPanel(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_TYPE, board, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand("stashboard.openBoard", () => board.openPanel()),
      vscode.commands.registerCommand("stashboard.focusSidebar", () =>
        vscode.commands.executeCommand(`${VIEW_TYPE}.focus`)
      ),
      // SCM sidebar calls this after its own refresh so both surfaces stay in sync.
      vscode.commands.registerCommand("stashboard.boardSync", () => void board.refresh())
    );
    return board;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.panel?.dispose();
    this.panel = undefined;
    this.log.dispose();
  }

  /** Open (or reveal) the full editor panel — primary board surface. */
  openPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      void this.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      "Stash Board",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "assets", "icon.png");
    this.panel = panel;
    this.wireWebview(panel.webview);
    panel.onDidDispose(
      () => {
        this.panel = undefined;
      },
      undefined,
      this.disposables
    );
    void this.refresh();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext<unknown>,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    this.wireWebview(webviewView.webview);
    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables
    );

    if (!this.disposables.some((d) => (d as { __sbRefresh?: boolean }).__sbRefresh)) {
      const sub = vscode.window.onDidChangeActiveTextEditor(() => this.refresh());
      (sub as { __sbRefresh?: boolean }).__sbRefresh = true;
      this.disposables.push(sub);
    }

    void this.refresh();
  }

  private wireWebview(webview: vscode.Webview): void {
    webview.html = this.renderHtml(webview);
    webview.onDidReceiveMessage(
      (msg) => void this.handleMessage(msg),
      undefined,
      this.disposables
    );
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private async handleMessage(msg: unknown): Promise<void> {
    const type =
      typeof (msg as { type?: unknown } | null)?.type === "string"
        ? (msg as { type: string }).type
        : "init";
    switch (type) {
      case "init":
      case "refresh":
        await this.refresh();
        break;
      case "stage":
        await this.run("stage", async () => {
          await this.requireService().boardStage(requirePath(msg, "path"));
        });
        break;
      case "unstage":
        await this.run("unstage", async () => {
          await this.requireService().boardUnstage(requirePath(msg, "path"));
        });
        break;
      case "add":
        await this.run("add", async () => {
          await this.requireService().boardAddToStash(
            requireString(msg, "stashId"),
            requirePath(msg, "path")
          );
        });
        break;
      case "restore":
        await this.run("restore", async () => {
          await this.requireService().boardRestoreFromStash(
            requireString(msg, "stashId"),
            requirePath(msg, "path"),
            { stage: (msg as { staged?: unknown }).staged === true }
          );
        });
        break;
      case "move":
        await this.run("move", async () => {
          await this.requireService().boardMoveBetweenStashes(
            requireString(msg, "fromStashId"),
            requireString(msg, "toStashId"),
            requirePath(msg, "path")
          );
        });
        break;
      case "create":
        await this.cmdCreate(msg);
        break;
      case "createAll":
        await this.cmdCreateAll();
        break;
      case "rename":
        await this.cmdRename(requireString(msg, "stashId"));
        break;
      case "delete":
        await this.cmdDelete(requireString(msg, "stashId"));
        break;
      case "restoreStash":
        await this.cmdRestoreStash(requireString(msg, "stashId"), false);
        break;
      case "stageStash":
        await this.cmdRestoreStash(requireString(msg, "stashId"), true);
        break;
      case "openFile":
        await this.cmdOpenFile(requireString(msg, "stashId"), requirePath(msg, "path"));
        break;
      case "openPanel":
        this.openPanel();
        break;
      default:
        this.post({ type: "state", busy: this.busy, view: null, error: `Unknown message: ${type}` });
    }
  }

  private async cmdCreate(msg: unknown): Promise<void> {
    const raw = (msg as { paths?: unknown }).paths;
    const paths = Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === "string" && p.length > 0).map((p) => p.split("\\").join("/"))
      : [];
    if (paths.length === 0) {
      await this.cmdCreateAll();
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Stash name",
      placeHolder: "e.g. Auth Refactor",
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "A name is required."),
    });
    if (name === undefined) return;
    await this.run("create", async () => {
      await this.requireService().save(paths, name);
    });
  }

  private async cmdCreateAll(): Promise<void> {
    if (!this.service || !this.repoPath) {
      await this.refresh("No git repository found in this workspace.");
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Stash name for all current changes",
      placeHolder: "e.g. WIP before lunch",
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "A name is required."),
    });
    if (name === undefined) return;
    await this.run("createAll", async () => {
      const state = await collectWorkingTreeState({ cwd: this.repoPath! });
      const files = [...state.staged, ...state.unstaged, ...state.untracked].filter(
        (f) => classifyPath(f, state) !== "mixed" && classifyPath(f, state) !== "unmerged"
      );
      if (files.length === 0) {
        throw new StashboardError("No changes to stash.");
      }
      await this.requireService().save(files, name);
    });
  }

  private async cmdRename(stashId: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "New stash name",
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "A name is required."),
    });
    if (name === undefined) return;
    await this.run("rename", async () => {
      await this.requireService().rename(stashId, name);
    });
  }

  private async cmdDelete(stashId: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete stash "${stashId}"? This permanently removes the stashed changes.`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") return;
    await this.run("delete", async () => {
      await this.requireService().delete(stashId);
    });
  }

  private async cmdRestoreStash(stashId: string, stage: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.post({ type: "state", busy: true });
    let error: string | undefined;
    try {
      const result = stage
        ? await this.requireService().stage(stashId)
        : await this.requireService().restore(stashId);
      this.log.appendLine(`[ok] ${stage ? "stageStash" : "restoreStash"}`);
      vscode.window.showInformationMessage(
        `${stage ? "Staged" : "Restored"} "${stashId}" — ${result.files.length} files.`
      );
    } catch (err) {
      await this.handleRestoreError(stashId, err);
      error = this.describeError(err);
    } finally {
      this.busy = false;
    }
    await this.refresh(error);
    await vscode.commands.executeCommand("stashboard.refresh");
  }

  private async handleRestoreError(id: string, err: unknown): Promise<void> {
    if (!(err instanceof RestoreConflictError)) {
      vscode.window.showErrorMessage(this.describeError(err));
      return;
    }
    const action = await vscode.window.showWarningMessage(
      err.message,
      "Mark resolved & drop stash",
      "Discard this restore attempt"
    );
    if (action === "Mark resolved & drop stash") {
      try {
        await this.requireService().delete(id);
        vscode.window.showInformationMessage(
          "Conflicts resolved — stash dropped. Your working tree keeps the changes."
        );
      } catch (e) {
        vscode.window.showErrorMessage(this.describeError(e));
      }
    } else if (action === "Discard this restore attempt") {
      try {
        await this.requireService().discardRestoreAttempt(id, err.conflictFiles);
        vscode.window.showInformationMessage(
          "Restore attempt reverted. The stash is intact."
        );
      } catch (e) {
        vscode.window.showErrorMessage(this.describeError(e));
      }
    }
  }

  /**
   * Run a board operation with a loading lock. Failed drops snap back because
   * the webview only renders host state.
   */
  private async run(op: string, operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.post({ type: "state", busy: true });
    let error: string | undefined;
    try {
      await operation();
      this.log.appendLine(`[ok] ${op}`);
    } catch (err) {
      error = this.describeError(err);
      this.log.appendLine(`[err] ${op}: ${error}`);
    } finally {
      this.busy = false;
    }
    await this.refresh(error);
    await vscode.commands.executeCommand("stashboard.refresh");
  }

  private async refresh(error?: string): Promise<void> {
    if (!this.view && !this.panel) return;
    const repo = await this.resolveRepo();
    if (!repo) {
      this.post({
        type: "state",
        busy: this.busy,
        view: null,
        error: error ?? "No git repository found in this workspace.",
      });
      return;
    }
    this.repoPath = repo;
    this.service = new StashService({ cwd: repo });
    let view: BoardView;
    try {
      view = await this.service.boardView();
    } catch (err) {
      this.post({
        type: "state",
        busy: this.busy,
        view: null,
        error: error ?? this.describeError(err),
      });
      return;
    }
    this.post({ type: "state", busy: this.busy, view, error });
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
  }

  // ---------------------------------------------------------------------------
  // Webview helpers
  // ---------------------------------------------------------------------------

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const media = (name: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", name)
      ).toString();
    let html: string;
    try {
      html = fs.readFileSync(
        path.join(this.context.extensionUri.fsPath, "media", "board.html"),
        "utf8"
      );
    } catch {
      html = "<!DOCTYPE html><html><body>Missing media/board.html</body></html>";
    }
    return html
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{styleUri}}", media("board.css"))
      .replaceAll("{{scriptUri}}", media("board.js"));
  }

  private describeError(err: unknown): string {
    if (err instanceof BoardConflictError) {
      return `Could not move "${err.file}": ${err.message}`;
    }
    if (err instanceof MixedStateError) {
      return err.message;
    }
    if (err instanceof StashboardError) {
      return err.message;
    }
    return `StashBoard error: ${(err as Error).message ?? String(err)}`;
  }

  private async cmdOpenFile(stashId: string, file: string): Promise<void> {
    const service = this.requireService();
    try {
      const ref = await service.getStashRef(stashId);
      const current = vscode.Uri.file(path.join(this.repoPath!, file));
      const stash = fileDiffUri(this.repoPath!, ref, file);
      await vscode.commands.executeCommand("vscode.diff", stash, current, `${stashId}: ${file}`);
    } catch (err) {
      vscode.window.showErrorMessage(this.describeError(err));
    }
  }

  private requireService(): StashService {
    if (!this.service || !this.repoPath) {
      throw new StashboardError("No git repository found in this workspace.");
    }
    return this.service;
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
      // fall through to the git-directory probe below
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        if (await isInsideRepo({ cwd: folder.uri.fsPath })) {
          return folder.uri.fsPath;
        }
      } catch {
        // not a repo — try the next folder
      }
    }
    return undefined;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function requireString(msg: unknown, key: string): string {
  const v = (msg as Record<string, unknown>)?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new StashboardError(`Missing ${key}.`);
  }
  return v;
}

function requirePath(msg: unknown, key: string): string {
  const v = requireString(msg, key);
  return v.split("\\").join("/");
}
