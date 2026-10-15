import * as path from "node:path";
import * as vscode from "vscode";
import {
  StashboardError,
  MixedStateError,
  RestoreConflictError,
  StashService,
  classifyPath,
  collectWorkingTreeState,
  isInsideRepo,
  stashFileEntries,
} from "@stashboard/core";
import { fileDiffUri, previewUri, StashContentProvider } from "./stashContentProvider";
import {
  StashDecorationProvider,
  scmResourceUri,
  statusLetter,
  statusTooltip,
} from "./statusDecorations";

interface GitRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}

interface GitExtensionApi {
  getRepository(uri: vscode.Uri): GitRepository | undefined;
  repositories: GitRepository[];
  onDidOpenRepository?: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitExtensionApi;
}

const REFRESH_DEBOUNCE_MS = 400;
const STASH_COUNT_WARNING_THRESHOLD = 20;

export class StashBoardSCM implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private scm: vscode.SourceControl | undefined;
  private groups = new Map<string, vscode.SourceControlResourceGroup>();
  private service: StashService | undefined;
  private repoPath: string | undefined;
  private gitApi: GitExtensionApi | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private stashWarningShown = false;
  private decorations: StashDecorationProvider | undefined;

  async activate(_context: vscode.ExtensionContext): Promise<void> {
    StashContentProvider.register(_context);
    this.decorations = StashDecorationProvider.register(_context);
    try {
      const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
      if (ext) {
        const api = ext.isActive ? ext.exports : await ext.activate();
        this.gitApi = api?.getAPI(1);
      }
    } catch {
      this.gitApi = undefined;
    }

    this.hookGitRepos();

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.commands.registerCommand("stashboard.save", (uri, selected) =>
        this.cmdSave(uri, selected)
      ),
      vscode.commands.registerCommand("stashboard.restore", (arg) => this.cmdRestore(arg)),
      vscode.commands.registerCommand("stashboard.stage", (arg) => this.cmdStage(arg)),
      vscode.commands.registerCommand("stashboard.preview", (arg) => this.cmdPreview(arg)),
      vscode.commands.registerCommand("stashboard.rename", (arg) => this.cmdRename(arg)),
      vscode.commands.registerCommand("stashboard.delete", (arg) => this.cmdDelete(arg)),
      vscode.commands.registerCommand("stashboard.openFile", (stashId, file) => {
        if (stashId && typeof stashId === "object" && "stashId" in stashId && "file" in stashId) {
          const item = stashId as { stashId: string; file: string };
          return this.cmdOpenFile(item.stashId, item.file);
        }
        return this.cmdOpenFile(stashId, file);
      }),
      vscode.commands.registerCommand("stashboard.refresh", () => this.refresh())
    );

    await this.refresh();
  }

  private hookGitRepos(): void {
    if (!this.gitApi) return;
    const api = this.gitApi as GitExtensionApi & {
      onDidOpenRepository?: vscode.Event<GitRepository>;
    };
    const watch = (repo: GitRepository) => {
      this.disposables.push(repo.state.onDidChange(() => this.scheduleRefresh()));
    };
    for (const repo of api.repositories) watch(repo);
    if (api.onDidOpenRepository) {
      this.disposables.push(api.onDidOpenRepository(watch));
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.scm?.dispose();
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // ---------------------------------------------------------------------------
  // Refresh / render
  // ---------------------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    try {
      const repo = await this.resolveRepo();
      if (!repo) {
        this.teardownScm();
        return;
      }
      this.repoPath = repo;
      this.service = new StashService({ cwd: repo });
      this.ensureScm();

      let stashes;
      try {
        stashes = await this.service.listStashes();
      } catch {
        this.teardownScm();
        return;
      }

      this.scm!.count = stashes.length;
      this.maybeWarnAboutStashCount(stashes.length);

      const liveIds = new Set(stashes.map((s) => s.id));
      for (const [id, group] of this.groups) {
        if (!liveIds.has(id)) {
          group.dispose();
          this.groups.delete(id);
        }
      }

      for (const stash of stashes) {
        const label = `${stash.name} (${stash.files.length})`;
        let group = this.groups.get(stash.id);
        if (!group) {
          group = this.scm!.createResourceGroup(stash.id, label);
          this.groups.set(stash.id, group);
        }
        group.label = label;

        let entries: { path: string; status: string }[] = [];
        try {
          const ref = await this.service!.getStashRef(stash.id);
          entries = await stashFileEntries({ cwd: repo, ref });
        } catch {
          entries = stash.files.map((file) => ({ path: file, status: "M" }));
        }
        // Deduplicate rename pairs (old+new) by path, last status wins.
        const byPath = new Map<string, string>();
        for (const e of entries) byPath.set(e.path, e.status);

        group.resourceStates = [...byPath.entries()].map(([file, status]) => {
          const letter = statusLetter(status);
          const tip = statusTooltip(letter);
          const state: vscode.SourceControlResourceState = {
            resourceUri: scmResourceUri(stash.id, file, letter),
            contextValue: "stashboardStashFile",
            decorations: {
              tooltip: tip,
              strikeThrough: letter === "D",
              faded: letter === "D",
            },
            command: {
              command: "stashboard.openFile",
              title: "Open in Stash",
              arguments: [stash.id, file],
            },
          };
          return state;
        });
      }
      this.decorations?.refresh();
    } finally {
      void vscode.commands.executeCommand("stashboard.boardSync");
    }
  }

  private ensureScm(): void {
    if (this.scm) return;
    const scm = vscode.scm.createSourceControl("stashboard", "StashBoard");
    // {0} is replaced by VS Code with the scm.acceptInput binding (Ctrl+Enter / Cmd+Enter).
    scm.inputBox.placeholder = "Stash name ({0} to save all)";
    scm.acceptInputCommand = {
      command: "stashboard.saveAll",
      title: "Save All Changes to Stash",
      arguments: [],
    };
    this.scm = scm;
    this.disposables.push(
      vscode.commands.registerCommand("stashboard.saveAll", () =>
        this.cmdSaveAllFromInput()
      )
    );
  }

  private teardownScm(): void {
    this.scm?.dispose();
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.scm = undefined;
    this.service = undefined;
    this.repoPath = undefined;
    this.stashWarningShown = false;
  }

  /**
   * Soft guidance (Section 15 of the master plan): no hard cap, never block the
   * user, never auto-delete. Just a gentle one-time-per-session reminder once a
   * good number of stashes have piled up.
   */
  private maybeWarnAboutStashCount(count: number): void {
    if (this.stashWarningShown || count < STASH_COUNT_WARNING_THRESHOLD) return;
    this.stashWarningShown = true;
    void vscode.window.showWarningMessage(
      `You have ${count} active stashes — consider cleaning up old ones before this gets unwieldy.`
    );
  }

  private async resolveRepo(): Promise<string | undefined> {
    if (this.gitApi) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active) {
        const repo = this.gitApi.getRepository(active);
        if (repo) return repo.rootUri.fsPath;
      }
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const repo = this.gitApi.getRepository(folder.uri);
        if (repo) return repo.rootUri.fsPath;
      }
      if (this.gitApi.repositories.length > 0) {
        return this.gitApi.repositories[0].rootUri.fsPath;
      }
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

  private requireService(): StashService {
    if (!this.service) {
      throw new StashboardError("No git repository found in this workspace.");
    }
    return this.service;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  private async cmdSave(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
    const service = this.requireService();
    const repo = this.repoPath!;
    const sources = selected && selected.length > 0 ? selected : uri ? [uri] : [];
    if (sources.length === 0) {
      vscode.window.showWarningMessage(
        "Select files in the Changes list, then use \"Save to Stash...\"."
      );
      return;
    }
    const files = sources.map((u) => toGitPath(path.relative(repo, u.fsPath)));

    const name = await vscode.window.showInputBox({
      prompt: "Stash name",
      placeHolder: "e.g. Auth Refactor",
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "A name is required."),
    });
    if (name === undefined) return;

    try {
      const stash = await service.save(files, name);
      await this.refresh();
      vscode.window.setStatusBarMessage(
        `StashBoard: saved "${stash.name}" (${stash.files.length} files)`,
        4000
      );
    } catch (err) {
      this.reportError(err);
    }
  }

  private async cmdSaveAllFromInput(): Promise<void> {
    const service = this.requireService();
    const name = this.scm?.inputBox.value.trim();
    if (!name) {
      vscode.window.showWarningMessage("Type a stash name in the StashBoard input box first.");
      return;
    }
    const state = await collectWorkingTreeState({ cwd: this.repoPath! });
    const files = [...state.staged, ...state.unstaged, ...state.untracked].filter(
      (f) => classifyPath(f, state) !== "mixed" && classifyPath(f, state) !== "unmerged"
    );
    if (files.length === 0) {
      vscode.window.showInformationMessage("No changes to stash.");
      return;
    }
    try {
      const stash = await service.save(files, name);
      this.scm!.inputBox.value = "";
      await this.refresh();
      vscode.window.setStatusBarMessage(
        `StashBoard: saved "${stash.name}" (${stash.files.length} files)`,
        4000
      );
    } catch (err) {
      this.reportError(err);
    }
  }

  private async cmdRestore(arg?: unknown): Promise<void> {
    const id = await this.resolveTarget(arg);
    if (!id) return;
    try {
      const result = await this.requireService().restore(id);
      await this.refresh();
      vscode.window.showInformationMessage(
        `Restored "${id}" — ${result.files.length} files back in the working tree.`
      );
    } catch (err) {
      await this.handleRestoreError(id, err);
    }
  }

  private async cmdStage(arg?: unknown): Promise<void> {
    const id = await this.resolveTarget(arg);
    if (!id) return;
    try {
      const result = await this.requireService().stage(id);
      await this.refresh();
      vscode.window.showInformationMessage(
        `Staged "${id}" — ${result.files.length} files.`
      );
    } catch (err) {
      await this.handleRestoreError(id, err);
    }
  }

  private async handleRestoreError(id: string, err: unknown): Promise<void> {
    if (err instanceof RestoreConflictError) {
      const action = await vscode.window.showWarningMessage(
        err.message,
        "Mark resolved & drop stash",
        "Discard this restore attempt"
      );
      if (action === "Mark resolved & drop stash") {
        try {
          await this.requireService().delete(id);
          await this.refresh();
          vscode.window.showInformationMessage(
            "Conflicts resolved — stash dropped. Your working tree keeps the changes."
          );
        } catch (e) {
          this.reportError(e);
        }
      } else if (action === "Discard this restore attempt") {
        try {
          await this.requireService().discardRestoreAttempt(id, err.conflictFiles);
          await this.refresh();
          vscode.window.showInformationMessage(
            "Restore attempt reverted. The stash is intact."
          );
        } catch (e) {
          this.reportError(e);
        }
      }
      return;
    }
    this.reportError(err);
  }

  private async cmdPreview(arg?: unknown): Promise<void> {
    const id = await this.resolveTarget(arg);
    if (!id) return;
    const service = this.requireService();
    try {
      const ref = await service.getStashRef(id);
      const uri = previewUri(this.repoPath!, ref, "stash.diff");
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      try {
        await vscode.languages.setTextDocumentLanguage(editor.document, "diff");
      } catch {
        // language switch is best-effort
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  private async cmdRename(arg?: unknown): Promise<void> {
    const id = await this.resolveTarget(arg);
    if (!id) return;
    const name = await vscode.window.showInputBox({
      prompt: "New stash name",
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "A name is required."),
    });
    if (name === undefined) return;
    try {
      const stash = await this.requireService().rename(id, name);
      await this.refresh();
      vscode.window.showInformationMessage(`Renamed stash to "${stash.name}".`);
    } catch (err) {
      this.reportError(err);
    }
  }

  private async cmdDelete(arg?: unknown): Promise<void> {
    const id = await this.resolveTarget(arg);
    if (!id) return;
    const confirm = await vscode.window.showWarningMessage(
      `Delete stash "${id}"? This permanently removes the stashed changes.`,
      { modal: true },
      "Delete"
    );
    if (confirm !== "Delete") return;
    try {
      await this.requireService().delete(id);
      await this.refresh();
      vscode.window.showInformationMessage(`Deleted stash "${id}".`);
    } catch (err) {
      this.reportError(err);
    }
  }

  private async cmdOpenFile(stashId?: string, file?: string): Promise<void> {
    if (!stashId || !file) return;
    const service = this.requireService();
    try {
      const ref = await service.getStashRef(stashId);
      const current = vscode.Uri.file(path.join(this.repoPath!, file));
      const stash = fileDiffUri(this.repoPath!, ref, file);
      await vscode.commands.executeCommand(
        "vscode.diff",
        stash,
        current,
        `${stashId}: ${file}`
      );
    } catch (err) {
      this.reportError(err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async resolveTarget(arg?: unknown): Promise<string | undefined> {
    if (typeof arg === "string" && arg.length > 0) return arg;
    if (arg && typeof arg === "object") {
      const candidate = arg as { id?: unknown; stashId?: unknown };
      if (typeof candidate.stashId === "string") return candidate.stashId;
      if (typeof candidate.id === "string") return candidate.id;
    }
    const stashes = await this.requireService().listStashes();
    if (stashes.length === 0) {
      vscode.window.showInformationMessage("No stashes yet. Select files in the Changes list and choose \"Save to Stash...\".");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      stashes.map((s) => ({
        label: s.name,
        description: `${s.files.length} file${s.files.length === 1 ? "" : "s"}`,
        detail: s.recovered ? "recovered" : undefined,
        id: s.id,
      })),
      { placeHolder: "Choose a stash" }
    );
    return picked?.id;
  }

  private reportError(err: unknown): void {
    if (err instanceof MixedStateError) {
      vscode.window.showErrorMessage(err.message, { modal: true });
      return;
    }
    if (err instanceof StashboardError) {
      vscode.window.showErrorMessage(err.message);
      return;
    }
    vscode.window.showErrorMessage(
      `StashBoard error: ${(err as Error).message ?? String(err)}`
    );
  }
}

function toGitPath(p: string): string {
  return p.split(path.sep).join("/");
}