import * as assert from 'assert';
import * as vscode from 'vscode';

import { WorkshopApiError } from '../api/client';
import { writeSession } from '../state';
import {
  currentWorkshop,
  ProjectContext,
  resolveCurrentProjectId,
  withProjectRetry,
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

  test('resolves a workshop window from its stored session', async () => {
    await writeSession(state, 'web.project-1.wp', {
      projectId: 'project-1',
      workshopName: 'web',
    });
    let ensured = false;
    const client = {
      ensureProject: async () => {
        ensured = true;
        return { id: 'wrong', path: '/wrong' };
      },
    };

    const projectId = await resolveCurrentProjectId(
      client,
      state,
      sshFolder('web.project-1.wp'),
    );

    assert.strictEqual(projectId, 'project-1');
    assert.strictEqual(ensured, false);
  });

  test('resolves a local window through the daemon', async () => {
    const client = {
      ensureProject: async (path: string) => ({ id: 'project-1', path }),
    };

    assert.strictEqual(
      await resolveCurrentProjectId(client, state, localFolder('/project')),
      'project-1',
    );
  });

  test('returns undefined without a remote session', async () => {
    const client = {
      ensureProject: async (path: string) => ({ id: 'project-1', path }),
    };

    assert.strictEqual(
      await resolveCurrentProjectId(client, state, sshFolder('web.project-1.wp')),
      undefined,
    );
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

  test('a workshop window resolves from its session without the daemon', async () => {
    await writeSession(state, 'web.project-1.wp', {
      projectId: 'project-1',
      workshopName: 'web',
    });
    const client = countingClient(['wrong']);
    const context = new ProjectContext(client, state, () => sshFolder('web.project-1.wp'));

    assert.strictEqual(await context.getId(), 'project-1');
    assert.strictEqual(client.calls, 0);
  });
});

suite('withProjectRetry', () => {
  let state: MemoryMemento;

  setup(() => {
    state = new MemoryMemento();
  });

  test('runs fn with the held id and does not re-resolve on success', async () => {
    const client = countingClient(['p1']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    const seen: string[] = [];
    const result = await withProjectRetry(context, async (id) => {
      seen.push(id);
      return 'ok';
    });

    assert.strictEqual(result, 'ok');
    assert.deepStrictEqual(seen, ['p1']);
    assert.strictEqual(client.calls, 1);
  });

  test('a 404 for the held id re-resolves the path and retries once', async () => {
    const client = countingClient(['stale', 'fresh']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    const seen: string[] = [];
    const result = await withProjectRetry(context, async (id) => {
      seen.push(id);
      if (id === 'stale') {
        throw new WorkshopApiError('not found', 404);
      }
      return `via-${id}`;
    });

    assert.strictEqual(result, 'via-fresh');
    assert.deepStrictEqual(seen, ['stale', 'fresh']);
    assert.strictEqual(await context.getId(), 'fresh', 'the fresh id is now held');
  });

  test('an error kind of not-found retries like a 404', async () => {
    const client = countingClient(['stale', 'fresh']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    const seen: string[] = [];
    await withProjectRetry(context, async (id) => {
      seen.push(id);
      if (id === 'stale') {
        throw new WorkshopApiError('gone', 400, 'not-found');
      }
      return 'ok';
    });

    assert.deepStrictEqual(seen, ['stale', 'fresh']);
  });

  test('retries only once: a second 404 propagates', async () => {
    const client = countingClient(['p1', 'p2']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    let attempts = 0;
    await assert.rejects(
      () => withProjectRetry(context, async () => {
        attempts += 1;
        throw new WorkshopApiError('still gone', 404);
      }),
      /still gone/,
    );
    assert.strictEqual(attempts, 2);
  });

  test('non-stale errors propagate without a retry', async () => {
    const client = countingClient(['p1']);
    const context = new ProjectContext(client, state, () => localFolder('/project'));

    let attempts = 0;
    await assert.rejects(
      () => withProjectRetry(context, async () => {
        attempts += 1;
        throw new WorkshopApiError('boom', 500);
      }),
      /boom/,
    );
    assert.strictEqual(attempts, 1);
    assert.strictEqual(client.calls, 1, 'no re-resolution for a non-404');
  });

  test('throws when no project is associated with the window', async () => {
    const client = countingClient(['unused']);
    const context = new ProjectContext(client, state, () => undefined);

    await assert.rejects(
      () => withProjectRetry(context, async () => 'unreachable'),
      /no workshop project/,
    );
  });
});
