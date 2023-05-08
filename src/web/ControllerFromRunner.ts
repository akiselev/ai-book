import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

async function replacePathWithContent(content: string, basePath: string): Promise<string> {
  const filePathRegex = /<%%\s*((?:[a-zA-Z]:|~)?[\\/]?[^\0<>:"|?*\\\/]+(?:[\\/][^\0<>:"|?*\\\/]+)*)\s*%%>/g;
  const matches = Array.from(content.matchAll(filePathRegex));

  for (const match of matches) {
    const filePath = match[1];
    const absolutePath = path.join(basePath, filePath.trimEnd());
    try {
      const fileContent = await fs.promises.readFile(absolutePath, "utf8");
      content = content.replace(match[0], fileContent);
    } catch (err: any) {
      vscode.window.showWarningMessage(`Error reading file at path, ${filePath}: ${err.message}`);
    }
  }

  return content;
}

// Retrieves the absolute path of the notebook directory
const getNotebookDirectoryPath = (notebook: vscode.NotebookDocument): string => {
  return path.dirname(notebook.uri.fsPath);
};

export type Message = { content: string; role: string }
export type Runner = (
  messages: Message[],
  notebook: vscode.NotebookDocument,
  clearOutput: () => Promise<void>,
  appendOutput: (content: string) => Promise<void>,
  appendTrace: (content: string) => Promise<void>,
  token: vscode.CancellationToken,
) => Promise<void>

export const ControllerFromRunner =
  (runner: Runner) =>
  async (
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
    controller: vscode.NotebookController,
  ): Promise<void> => {
    const cell = cells.at(-1)!
    const execution = controller.createNotebookCellExecution(cell)
    execution.start(Date.now())
    execution.clearOutput()

    let success = false
    try {
      const activeIndex = cell.index
      const nextIndex = activeIndex + 1

      let nextCell = cell.notebook.cellAt(nextIndex)
      const lastCell = nextCell === cell
      const nextIsAssistant = nextCell.document.languageId === "assistant"

      if (lastCell || !nextIsAssistant) {
        await vscode.commands.executeCommand(
          "notebook.cell.insertCodeCellBelow",
        )
        await vscode.commands.executeCommand(
          "notebook.cell.changeLanguage",
          { start: nextIndex, end: nextIndex + 1 },
          "assistant",
        )

        nextCell = cell.notebook.cellAt(nextIndex)
      }

      const rawMessages = notebook
      .getCells(new vscode.NotebookRange(0, activeIndex + 1))
        .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
        .map((cell) => ({
          content: cell.document.getText(),
          role: cell.document.languageId,
        }))
      
      const dirPath = getNotebookDirectoryPath(notebook);
      const messages = [];
      for (const message of rawMessages) {
        const content = await replacePathWithContent(message.content, dirPath);
        messages.push({ ...message, content });
      }

      const clearOutput = async () => {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          nextCell.document.uri,
          new vscode.Range(
            nextCell.document.positionAt(0),
            nextCell.document.positionAt(Infinity),
          ),
          "",
        )
        await vscode.workspace.applyEdit(edit)
      }

      const appendOutput = async (content: string): Promise<void> => {
        if (execution.token.isCancellationRequested) {
          return
        }

        const edit = new vscode.WorkspaceEdit()
        edit.insert(
          nextCell.document.uri,
          nextCell.document.positionAt(Infinity),
          content,
        )
        await vscode.workspace.applyEdit(edit)
      }

      const appendTrace = async (content: string) =>
        execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.stderr(content),
          ]),
        )

      await runner(
        messages,
        notebook,
        clearOutput,
        appendOutput,
        appendTrace,
        execution.token,
      )

      if (lastCell) {
        await vscode.commands.executeCommand(
          "notebook.cell.insertCodeCellBelow",
        )
        await vscode.commands.executeCommand(
          "notebook.cell.changeLanguage",
          { start: nextIndex + 1, end: nextIndex + 2 },
          "user",
        )
      }

      success = true
    } catch (e) {
      console.error(e)
      execution.appendOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(e as Error),
        ]),
      )
    } finally {
      execution.end(success, Date.now())
    }
  }
