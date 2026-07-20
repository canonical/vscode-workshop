import * as assert from 'assert';
import * as vscode from 'vscode';

import { writeSession } from '../state';
import { currentWorkshop, resolveCurrentProjectId } from '../workspaceContext';

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
