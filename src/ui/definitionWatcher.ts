import * as vscode from 'vscode';

/**
 * Glob patterns that match all valid workshop definition file locations,
 * relative to the workspace root:
 *
 *   - `workshop.yaml`         — single-workshop, root-level
 *   - `.workshop.yaml`        — single-workshop, root-level (dotfile form)
 *   - `.workshop/*.yaml`      — multi-workshop directory
 */
const DEFINITION_GLOBS = [
  'workshop.yaml',
  '.workshop.yaml',
  '.workshop/*.yaml',
] as const;

/**
 * Watch all workshop definition files in the workspace for changes.
 * Calls `onChanged` with the absolute filesystem path of the changed file.
 * The first change fires immediately; subsequent changes within `debounceMs`
 * are suppressed so that rapid saves (e.g. editor auto-save) don't flood the
 * caller with notifications.
 *
 * Returns a `Disposable` that stops the watcher when disposed.
 */
export function createDefinitionWatcher(
  onChanged: (filePath: string) => void,
  debounceMs = 800,
): vscode.Disposable {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function handleChange(uri: vscode.Uri): void {
    const key = uri.fsPath;
    const existing = timers.get(key);
    if (existing !== undefined) {
      // Already fired once; reset the debounce window and skip this event.
      clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
        }, debounceMs),
      );
    } else {
      // First change — fire immediately, then open a debounce window to
      // suppress further events while the user is still saving.
      onChanged(key);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
        }, debounceMs),
      );
    }
  }

  const watchers = DEFINITION_GLOBS.map((pattern) => {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.workspace.workspaceFolders?.[0] ?? '',
        pattern,
      ),
    );
    watcher.onDidChange(handleChange);
    watcher.onDidCreate(handleChange);
    return watcher;
  });

  return new vscode.Disposable(() => {
    for (const t of timers.values()) {
      clearTimeout(t);
    }
    timers.clear();
    for (const w of watchers) {
      w.dispose();
    }
  });
}
