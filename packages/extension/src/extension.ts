import * as vscode from "vscode";
import { BoardPanel } from "./board/boardPanel";
import { StashBoardSCM } from "./scmProvider";

let scm: StashBoardSCM | undefined;
let board: BoardPanel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  scm = new StashBoardSCM();
  context.subscriptions.push(scm);
  await scm.activate(context);

  board = BoardPanel.register(context);
}

export function deactivate(): void {
  scm?.dispose();
  scm = undefined;
  board?.dispose();
  board = undefined;
}