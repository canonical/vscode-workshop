import * as assert from 'assert';
import * as vscode from 'vscode';
import { createDefinitionWatcher } from '../ui/definitionWatcher';

// ---------------------------------------------------------------------------
// Stub for vscode.workspace.createFileSystemWatcher
// ---------------------------------------------------------------------------

interface FakeWatcher {
  fireChange(uri: vscode.Uri): void;
  fireCreate(uri: vscode.Uri): void;
  dispose(): void;
  disposed: boolean;
}

function installWatcherStub(): {
  watchers: FakeWatcher[];
  restore: () => void;
} {
  const watchers: FakeWatcher[] = [];

  const original = vscode.workspace.createFileSystemWatcher.bind(vscode.workspace);

  // The watcher no-ops without a workspace folder, so pretend one is open.
  const originalFolders = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    get: () => [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }],
  });

  // Each call to createFileSystemWatcher returns a new fake watcher that
  // records its change/create listeners and exposes fire helpers.
  (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher =
    (_pattern: unknown) => {
      let changeListener: ((uri: vscode.Uri) => void) | undefined;
      let createListener: ((uri: vscode.Uri) => void) | undefined;

      const fake: FakeWatcher = {
        disposed: false,
        fireChange: (uri) => { if (!fake.disposed) { changeListener?.(uri); } },
        fireCreate: (uri) => { if (!fake.disposed) { createListener?.(uri); } },
        dispose: () => { fake.disposed = true; },
      };

      // Minimal FileSystemWatcher shape (only the surface createDefinitionWatcher uses).
      const vscodeFake = {
        onDidChange: (fn: (uri: vscode.Uri) => void) => {
          changeListener = fn;
          return new vscode.Disposable(() => { changeListener = undefined; });
        },
        onDidCreate: (fn: (uri: vscode.Uri) => void) => {
          createListener = fn;
          return new vscode.Disposable(() => { createListener = undefined; });
        },
        dispose: () => fake.dispose(),
      } as unknown as vscode.FileSystemWatcher;

      watchers.push(fake);
      return vscodeFake;
    };

  return {
    watchers,
    restore: () => {
      (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = original;
      if (originalFolders) {
        Object.defineProperty(vscode.workspace, 'workspaceFolders', originalFolders);
      }
    },
  };
}

/** Wait for all pending microtasks and one timer tick. */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('createDefinitionWatcher', () => {
  let stub: ReturnType<typeof installWatcherStub>;

  setup(() => {
    stub = installWatcherStub();
  });

  teardown(() => {
    stub.restore();
  });

  test('fires onChanged immediately on first change', async () => {
    const calls: string[] = [];
    const disposable = createDefinitionWatcher((p) => calls.push(p), 50);

    // Three watchers are created (one per glob pattern); fire on the first.
    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));

    assert.deepStrictEqual(calls, ['/repo/workshop.yaml']);
    disposable.dispose();
  });

  test('suppresses a second change within the debounce window', async () => {
    const calls: string[] = [];
    const disposable = createDefinitionWatcher((p) => calls.push(p), 200);

    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));
    // Immediately fire again — within the debounce window.
    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));

    assert.strictEqual(calls.length, 1);
    disposable.dispose();
  });

  test('fires again after the debounce window expires', async () => {
    const calls: string[] = [];
    const disposable = createDefinitionWatcher((p) => calls.push(p), 20);

    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));
    assert.strictEqual(calls.length, 1);

    // Wait for the debounce window to expire.
    await flush(40);

    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));
    assert.strictEqual(calls.length, 2);

    disposable.dispose();
  });

  test('fires onChanged on onDidCreate too', async () => {
    const calls: string[] = [];
    const disposable = createDefinitionWatcher((p) => calls.push(p), 50);

    stub.watchers[1].fireCreate(vscode.Uri.file('/repo/.workshop.yaml'));

    assert.deepStrictEqual(calls, ['/repo/.workshop.yaml']);
    disposable.dispose();
  });

  test('fires independently for different files', async () => {
    const calls: string[] = [];
    const disposable = createDefinitionWatcher((p) => calls.push(p), 200);

    // Two different files — each has its own debounce key.
    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));
    stub.watchers[2].fireChange(vscode.Uri.file('/repo/.workshop/dev.yaml'));

    assert.deepStrictEqual(calls.sort(), [
      '/repo/.workshop/dev.yaml',
      '/repo/workshop.yaml',
    ]);
    disposable.dispose();
  });

  test('disposes all underlying watchers', () => {
    const disposable = createDefinitionWatcher(() => { /* no-op */ }, 50);
    disposable.dispose();

    assert.ok(stub.watchers.every((w) => w.disposed), 'all watchers should be disposed');
  });

  test('does not fire after dispose', async () => {
    const calls: string[] = [];
    const disposable = createDefinitionWatcher((p) => calls.push(p), 20);

    disposable.dispose();
    stub.watchers[0].fireChange(vscode.Uri.file('/repo/workshop.yaml'));

    await flush(40);
    assert.strictEqual(calls.length, 0);
  });
});
