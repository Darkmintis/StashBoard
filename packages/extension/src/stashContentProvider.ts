import * as vscode from "vscode";

export const SCHEME = "stashboard-stash";
export const PREVIEW_SCHEME = "stashboard-preview";

interface QueryParams {
  repo: string;
  ref: string;
  file: string;
}

function buildUri(scheme: string, file: string, params: QueryParams): vscode.Uri {
  const query = new URLSearchParams({
    repo: params.repo,
    ref: params.ref,
    file: params.file,
  }).toString();
  return vscode.Uri.parse(`${scheme}:${encodeURIComponent(file)}?${query}`);
}

/**
 * Read-only text documents backed by git. Serves the stored version of a file
 * (`git show <ref>:<path>`) or the full stash patch (`git stash show -p`),
 * which lets us reuse VS Code's native diff editor and viewer.
 */
export class StashContentProvider implements vscode.TextDocumentContentProvider {
  static register(context: vscode.ExtensionContext): StashContentProvider {
    const provider = new StashContentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider)
    );
    return provider;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const repo = query.get("repo");
    const ref = query.get("ref");
    const file = query.get("file");
    if (!repo || !ref) return "(invalid reference)";

    if (uri.scheme === PREVIEW_SCHEME) {
      const { execFile } = await import("node:child_process");
      return new Promise((resolve) => {
        execFile(
          "git",
          ["stash", "show", "-p", "-u", "--textconv", ref],
          { cwd: repo, maxBuffer: 128 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
          (_err, stdout) => resolve(stdout)
        );
      });
    }

    // Per-file content for the native diff editor.
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile(
        "git",
        ["show", `${ref}:${file}`],
        { cwd: repo, maxBuffer: 128 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
        (err, stdout) => {
          if (err) {
            resolve("(binary or missing in this stash)");
            return;
          }
          resolve(stdout);
        }
      );
    });
  }
}

export function fileDiffUri(
  repo: string,
  ref: string,
  file: string
): vscode.Uri {
  return buildUri(SCHEME, file, { repo, ref, file });
}

export function previewUri(
  repo: string,
  ref: string,
  file: string
): vscode.Uri {
  return buildUri(PREVIEW_SCHEME, file, { repo, ref, file });
}
