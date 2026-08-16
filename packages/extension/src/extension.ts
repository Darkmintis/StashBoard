import * as vscode from "vscode";
import { StashBoardSCM } from "./scmProvider";

let scm: StashBoardSCM | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  scm = new StashBoardSCM();
  context.subscriptions.push(scm);
  await scm.activate(context);
}

export function deactivate(): void {
  scm?.dispose();
  scm = undefined;
}