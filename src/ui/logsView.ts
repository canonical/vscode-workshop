import * as vscode from 'vscode';

const SCHEME = 'workshop-log';

/**
 * Shows captured error output in a read-only preview editor tab — scrollable
 * and searchable, opening beside the YAML definition when possible.
 *
 * Backed by a `TextDocumentContentProvider` so the log appears as a normal
 * editor tab rather than the Output panel, and can be diffed, searched, etc.
 */
export class LogsView {
  private readonly bodies = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  private uriFor(title: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}:${encodeURIComponent(title)}.log`);
  }

  register(context: vscode.ExtensionContext): void {
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this.onDidChangeEmitter.event,
      provideTextDocumentContent: (uri) => this.bodies.get(uri.toString()) ?? '',
    };
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
      this.onDidChangeEmitter,
    );
  }

  /**
   * Update the content of an already-open log tab without re-focusing it.
   * If the tab has not been opened yet this is a no-op — use {@link openLog}
   * for the initial open.
   */
  updateLog(title: string, text: string): void {
    const uri = this.uriFor(title);
    this.bodies.set(uri.toString(), text || '(no output captured)');
    this.onDidChangeEmitter.fire(uri);
  }

  /**
   * Open (or refresh) a read-only preview editor showing `text`.
   *
   * Pass `column` to force placement; otherwise the log opens beside the
   * current active editor (or in the active column if none is open).
   */
  async openLog(title: string, text: string, column?: vscode.ViewColumn): Promise<void> {
    const uri = this.uriFor(title);
    this.bodies.set(uri.toString(), text || '(no output captured)');
    this.onDidChangeEmitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const viewColumn =
      column ??
      (vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn });
  }
}
