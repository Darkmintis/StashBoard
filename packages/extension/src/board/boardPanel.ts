import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  BoardConflictError,
  MixedStateError,
  StashService,
  StashboardError,
  isInsideRepo,
  type BoardView,
} from "@stashboard/core";
import { fileDiffUri } from "../stashContentProvider";

const VIEW_TYPE = "stashboard.board";

/** One begin/end pair of the three-column drag-and-drop board. */
export class BoardPanel implements vscode.Disposable {
  static viewType = VIEW_TYPE;

  private disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private service: StashService | undefined;
  private repoPath: string | undefined;
  private busy = false;
  private log = vscode.window.createOutputChannel("StashBoard Board");

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Register the panel as a webview-view provider plus the "Open Board"
   * command that reveals it. Called once from `activate`.
   */
  static register(context: vscode.ExtensionContext): BoardPanel {
    const panel = new BoardPanel(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_TYPE, panel, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand("stashboard.openBoard", () =>
        vscode.commands.executeCommand(`${VIEW_TYPE}.focus`)
      )
    );
    return panel;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.log.dispose();
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
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg) => void this.handleMessage(msg),
      undefined,
      this.disposables
    );
    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables
    );

    // Refresh on repo selection change, matching the SCM sidebar behavior.
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
    );

    void this.refresh();
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
        await this.refresh();
        break;
      case "refresh":
        await this.refresh();
        break;
      case "stage":
        await this.run("stage", async () => {
          await this.requireService().boardStage(requirePath(msg, "path"));
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
      case "openFile":
        await this.cmdOpenFile(requireString(msg, "stashId"), requirePath(msg, "path"));
        break;
      default:
        this.post({ type: "state", busy: this.busy, view: null, error: `Unknown message: ${type}` });
    }
  }

  /**
   * Run a board operation with a loading lock around it. The webview never
   * mutates optimistically — it only renders state we send back, so a failed
   * drop naturally snaps the card back.
   */
  private async run(op: string, operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.post({ type: "state", busy: true });
    try {
      await operation();
      this.log.appendLine(`[ok] ${op}`);
      await this.refresh();
    } catch (err) {
      const message = this.describeError(err);
      this.log.appendLine(`[err] ${op}: ${message}`);
      await this.refresh(message);
    } finally {
      this.busy = false;
    }
  }

  private async refresh(error?: string): Promise<void> {
    if (!this.view) return;
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