import * as vscode from "vscode";
import { BoardPanel } from "./board/boardPanel";
import { StashBoardSCM } from "./scmProvider";
import { StashItem, StashTree } from "./stashTree";

let scm: StashBoardSCM | undefined;
let board: BoardPanel | undefined;
let tree: StashTree | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  tree = StashTree.register(context);
  board = BoardPanel.register(context);

  // One sync fan-out so SCM, board, and sidebar tree stay aligned.
  context.subscriptions.push(
    vscode.commands.registerCommand("stashboard.boardSync", () => {
      board?.sync();
      tree?.refresh();
    }),
    vscode.commands.registerCommand("stashboard.newStash", () => board?.createAll()),
    vscode.commands.registerCommand("stashboard.deleteStash", (item?: StashItem | string) => {
      const id = item instanceof StashItem ? item.stashId : typeof item === "string" ? item : undefined;
      if (!id) return vscode.commands.executeCommand("stashboard.delete");
      return vscode.commands.executeCommand("stashboard.delete", id);
    })
  );

  scm = new StashBoardSCM();
  context.subscriptions.push(scm);
  await scm.activate(context);
}

export function deactivate(): void {
  scm?.dispose();
  scm = undefined;
  board?.dispose();
  board = undefined;
  tree?.dispose();
  tree = undefined;
}
