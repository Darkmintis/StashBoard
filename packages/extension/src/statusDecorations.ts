import * as vscode from "vscode";

/** Scheme for SCM resource URIs so FileDecoration badges do not clash with Git. */
export const SCM_SCHEME = "stashboard-scm";

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Untracked",
};

const STATUS_COLORS: Record<string, string> = {
  M: "gitDecoration.modifiedResourceForeground",
  A: "gitDecoration.addedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  C: "gitDecoration.renamedResourceForeground",
  T: "gitDecoration.modifiedResourceForeground",
  U: "gitDecoration.untrackedResourceForeground",
};

export function statusLetter(status: string): string {
  const s = (status || "M").toUpperCase();
  if (s === "??") return "U";
  return s.charAt(0);
}

export function statusTooltip(status: string): string {
  const letter = statusLetter(status);
  return STATUS_LABELS[letter] ?? letter;
}

export function statusColor(status: string): vscode.ThemeColor {
  const letter = statusLetter(status);
  return new vscode.ThemeColor(
    STATUS_COLORS[letter] ?? "gitDecoration.modifiedResourceForeground"
  );
}

export function scmResourceUri(
  stashId: string,
  file: string,
  status: string
): vscode.Uri {
  const normalized = file.split("\\").join("/");
  return vscode.Uri.from({
    scheme: SCM_SCHEME,
    authority: stashId,
    path: "/" + normalized.replace(/^\//, ""),
    query: `status=${encodeURIComponent(statusLetter(status))}`,
  });
}

/** FileDecorationProvider - shows M/U/A/D badges next to stash files in SCM. */
export class StashDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  static register(context: vscode.ExtensionContext): StashDecorationProvider {
    const provider = new StashDecorationProvider();
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(provider),
      provider
    );
    return provider;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== SCM_SCHEME) return undefined;
    const status = new URLSearchParams(uri.query).get("status") ?? "M";
    const letter = statusLetter(status);
    const decoration = new vscode.FileDecoration(
      letter,
      statusTooltip(letter),
      statusColor(letter)
    );
    decoration.propagate = false;
    return decoration;
  }
}
