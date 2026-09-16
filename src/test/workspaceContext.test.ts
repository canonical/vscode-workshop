import * as assert from 'assert';
import * as vscode from 'vscode';

import { writeSession } from '../state';
import {
  currentWorkshop,
  ProjectContext,
} from '../workspaceContext';

class MemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {}
}

function localFolder(path: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(path), name: 'local', index: 0 };
}

function sshFolder(hostname: string): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.parse(`vscode-remote://ssh-remote+${hostname}/project`),
    name: 'remote',
    index: 0,
  };
}

suite('workspace context', () => {
  let state: MemoryMemento;

  setup(() => {
    state = new MemoryMemento();
  });

  test('returns the hostname and session for a workshop window', async () => {
    const session = { projectId: 'project-1', workshopName: 'web' };
    await writeSession(state, 'web.project-1.wp', session);

    assert.deepStrictEqual(currentWorkshop(state, sshFolder('web.project-1.wp')), {
      hostname: 'web.project-1.wp',
      session,
    });
  });

});

/** A client stub minting a new id per POST, like a daemon re-issuing ids. */
function countingClient(ids: string[]): { calls: number; ensureProject(path: string): Promise<{ id: string; path: string }> } {
  return {
    calls: 0,
    async ensureProject(path: string) {
      const id = ids[Math.min(this.calls, ids.length - 1)];
      this.calls += 1;
      return { id, path };
    },
  };
}

suite('ProjectContext', () => {
  let state: MemoryMemento;

  setup(() => {
    state = new MemoryMemento();
  });

  test('resolves once and holds the id across getId calls', async () => {
    const client = countingClient(['p1']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    assert.strictEqual(await context.getId(), 'p1');
    assert.strictEqual(await context.getId(), 'p1');
    assert.strictEqual(client.calls, 1, 'the daemon is asked once, not per call');
  });

  test('concurrent resolutions share one daemon request', async () => {
    let release: ((value: { id: string; path: string }) => void) | undefined;
    let calls = 0;
    const client = {
      ensureProject: (_path: string) => {
        calls += 1;
        return new Promise<{ id: string; path: string }>((r) => { release = r; });
      },
    };
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    const a = context.getId();
    const b = context.getId();
    release?.({ id: 'p1', path: '/project' });

    assert.deepStrictEqual(await Promise.all([a, b]), ['p1', 'p1']);
    assert.strictEqual(calls, 1);
  });

  test('invalidate drops the held id so the next getId re-resolves', async () => {
    const client = countingClient(['p1', 'p2']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    assert.strictEqual(await context.getId(), 'p1');
    context.invalidate();
    assert.strictEqual(await context.getId(), 'p2');
    assert.strictEqual(client.calls, 2);
  });

  test('invalidate during an in-flight resolution does not write the stale id back', async () => {
    const releases: Array<(value: { id: string; path: string }) => void> = [];
    let currentFolder = localFolder('/a');
    const client = {
      ensureProject: (path: string) =>
        new Promise<{ id: string; path: string }>((resolve) => {
          releases.push((value) => resolve({ ...value, path }));
        }),
    };
    const context = new ProjectContext(client, state, () => currentFolder);

    // A resolution for /a starts but has not completed.
    const first = context.getId();
    // The workspace folder changes: invalidate, then resolve afresh for /b.
    currentFolder = localFolder('/b');
    context.invalidate();
    const second = context.getId();

    // The fresh resolution settles first, then the superseded one.
    releases[1]({ id: 'b', path: '/b' });
    releases[0]({ id: 'a', path: '/a' });
    await Promise.all([first, second]);

    assert.strictEqual(
      await context.getId(),
      'b',
      'the superseded resolution must not overwrite the fresh id',
    );
  });

  test('a resolution invalidated mid-flight does not return the superseded id', async () => {
    const releases: Array<(value: { id: string; path: string }) => void> = [];
    let currentFolder = localFolder('/a');
    const client = {
      ensureProject: (path: string) =>
        new Promise<{ id: string; path: string }>((resolve) => {
          releases.push((value) => resolve({ ...value, path }));
        }),
    };
    const context = new ProjectContext(client, state, () => currentFolder);

    const first = context.getId();
    currentFolder = localFolder('/b');
    context.invalidate();
    const second = context.getId();

    // The fresh resolution settles first, then the superseded one.
    releases[1]({ id: 'b', path: '/b' });
    releases[0]({ id: 'a', path: '/a' });

    assert.strictEqual(await first, 'b', 'the in-flight caller must not receive the old folder id');
    assert.strictEqual(await second, 'b');
  });

  test('a joined caller also honours a mid-flight invalidation', async () => {
    await writeSession(state, 'web.project-1.wp', {
      projectId: 'session-b',
      workshopName: 'web',
    });
    const releases: Array<(value: { id: string; path: string }) => void> = [];
    let currentFolder = localFolder('/a');
    const client = {
      ensureProject: (path: string) =>
        new Promise<{ id: string; path: string }>((resolve) => {
          releases.push((value) => resolve({ ...value, path }));
        }),
    };
    const context = new ProjectContext(client, state, () => currentFolder);

    // Two callers share one in-flight resolution for /a.
    const first = context.getId();
    const joined = context.getId();
    // The window switches to a workshop folder before /a resolves.
    currentFolder = sshFolder('web.project-1.wp');
    context.invalidate();

    // The superseded /a resolution settles; both waiters must re-resolve to the
    // current (session) id rather than receive the stale /a id.
    releases[0]({ id: 'a', path: '/a' });

    assert.strictEqual(await first, 'session-b');
    assert.strictEqual(await joined, 'session-b', 'the joined caller must not receive the stale id');
  });

  test('a failed resolution is not held: the next getId retries', async () => {
    let fail = true;
    const client = {
      ensureProject: async (path: string) => {
        if (fail) {
          throw new Error('daemon down');
        }
        return { id: 'p1', path };
      },
    };
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    await assert.rejects(() => context.getId(), /daemon down/);
    fail = false;
    assert.strictEqual(await context.getId(), 'p1');
  });

  test('a workshop window uses its persisted session project id', async () => {
    await writeSession(state, 'web.project-1.wp', {
      projectId: 'project-1',
      workshopName: 'web',
    });
    const client = countingClient(['fresh']);
    const context = new ProjectContext(client, state, () => sshFolder('web.project-1.wp'));

    assert.strictEqual(await context.getId(), 'project-1');
    assert.strictEqual(client.calls, 0);
  });

  test('a workshop window without a session does not register its remote path', async () => {
    const client = countingClient(['wrong']);
    const context = new ProjectContext(client, state, () => sshFolder('web.project-1.wp'));

    assert.strictEqual(await context.getId(), undefined);
    assert.strictEqual(client.calls, 0);
  });
});
