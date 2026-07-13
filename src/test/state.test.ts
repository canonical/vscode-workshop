import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  hostnameFromFolder,
  readSession,
  writeSession,
  clearSession,
  readPendingOp,
  writePendingOp,
  clearPendingOp,
  resolveLocalProjectPath,
  SESSIONS_KEY,
  PENDING_OPS_KEY,
  WorkshopSession,
  PendingOperation,
} from '../state';

// ---------------------------------------------------------------------------
// Minimal in-memory Memento stub
// ---------------------------------------------------------------------------

class MemoryMemento implements vscode.Memento {
  private store = new Map<string, unknown>();

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

  setKeysForSync(_keys: readonly string[]): void { /* no-op in tests */ }
}

// ---------------------------------------------------------------------------
// Helpers for building fake WorkspaceFolder URIs
// ---------------------------------------------------------------------------

function localFolder(fsPath: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(fsPath), name: 'local', index: 0 };
}

function sshFolder(hostname: string): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.parse(`vscode-remote://ssh-remote+${hostname}/project`),
    name: 'remote',
    index: 0,
  };
}

// ---------------------------------------------------------------------------
// hostnameFromFolder
// ---------------------------------------------------------------------------

suite('hostnameFromFolder', () => {
  test('returns undefined for undefined folder', () => {
    assert.strictEqual(hostnameFromFolder(undefined), undefined);
  });

  test('returns undefined for a local file:// folder', () => {
    assert.strictEqual(hostnameFromFolder(localFolder('/home/user/project')), undefined);
  });

  test('extracts hostname from vscode-remote URI', () => {
    assert.strictEqual(hostnameFromFolder(sshFolder('web.proj-1.wp')), 'web.proj-1.wp');
  });

  test('returns undefined when authority does not start with ssh-remote+', () => {
    const folder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.parse('vscode-remote://other-remote+host/project'),
      name: 'other',
      index: 0,
    };
    assert.strictEqual(hostnameFromFolder(folder), undefined);
  });
});

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

suite('session helpers', () => {
  let state: MemoryMemento;

  setup(() => { state = new MemoryMemento(); });

  test('readSession returns undefined when nothing stored', () => {
    assert.strictEqual(readSession(state, 'web.proj-1.wp'), undefined);
  });

  test('writeSession persists session keyed by hostname', async () => {
    const session: WorkshopSession = { localProjectPath: '/home/user/p', workshopName: 'web' };
    await writeSession(state, 'web.proj-1.wp', session);
    assert.deepStrictEqual(readSession(state, 'web.proj-1.wp'), session);
  });

  test('writeSession does not clobber other hostnames', async () => {
    const s1: WorkshopSession = { localProjectPath: '/a', workshopName: 'web' };
    const s2: WorkshopSession = { localProjectPath: '/b', workshopName: 'api' };
    await writeSession(state, 'host-1.wp', s1);
    await writeSession(state, 'host-2.wp', s2);
    assert.deepStrictEqual(readSession(state, 'host-1.wp'), s1);
    assert.deepStrictEqual(readSession(state, 'host-2.wp'), s2);
  });

  test('clearSession removes the hostname entry', async () => {
    await writeSession(state, 'web.proj-1.wp', { localProjectPath: '/p', workshopName: 'web' });
    await clearSession(state, 'web.proj-1.wp');
    assert.strictEqual(readSession(state, 'web.proj-1.wp'), undefined);
  });

  test('clearSession leaves other hostnames intact', async () => {
    const s1: WorkshopSession = { localProjectPath: '/a', workshopName: 'web' };
    const s2: WorkshopSession = { localProjectPath: '/b', workshopName: 'api' };
    await writeSession(state, 'host-1.wp', s1);
    await writeSession(state, 'host-2.wp', s2);
    await clearSession(state, 'host-1.wp');
    assert.strictEqual(readSession(state, 'host-1.wp'), undefined);
    assert.deepStrictEqual(readSession(state, 'host-2.wp'), s2);
  });

  test('clearSession on last entry removes the key entirely', async () => {
    await writeSession(state, 'web.proj-1.wp', { localProjectPath: '/p', workshopName: 'web' });
    await clearSession(state, 'web.proj-1.wp');
    assert.strictEqual(state.get(SESSIONS_KEY), undefined);
  });
});

// ---------------------------------------------------------------------------
// Pending-operation helpers
// ---------------------------------------------------------------------------

suite('pendingOp helpers', () => {
  let state: MemoryMemento;

  setup(() => { state = new MemoryMemento(); });

  test('readPendingOp returns undefined when nothing stored', () => {
    assert.strictEqual(readPendingOp(state, '/home/user/project'), undefined);
  });

  test('writePendingOp persists op keyed by localProjectPath', async () => {
    const op: PendingOperation = { kind: 'refresh', workshopName: 'web', mode: 'continue' };
    await writePendingOp(state, '/home/user/project', op);
    assert.deepStrictEqual(readPendingOp(state, '/home/user/project'), op);
  });

  test('writePendingOp does not clobber other paths', async () => {
    const op1: PendingOperation = { kind: 'refresh', workshopName: 'web', mode: 'continue' };
    const op2: PendingOperation = { kind: 'turn-off', workshopName: 'api' };
    await writePendingOp(state, '/project-a', op1);
    await writePendingOp(state, '/project-b', op2);
    assert.deepStrictEqual(readPendingOp(state, '/project-a'), op1);
    assert.deepStrictEqual(readPendingOp(state, '/project-b'), op2);
  });

  test('clearPendingOp removes the path entry', async () => {
    await writePendingOp(state, '/project', { kind: 'turn-off', workshopName: 'web' });
    await clearPendingOp(state, '/project');
    assert.strictEqual(readPendingOp(state, '/project'), undefined);
  });

  test('clearPendingOp leaves other paths intact', async () => {
    const op: PendingOperation = { kind: 'turn-off', workshopName: 'api' };
    await writePendingOp(state, '/project-a', { kind: 'turn-off', workshopName: 'web' });
    await writePendingOp(state, '/project-b', op);
    await clearPendingOp(state, '/project-a');
    assert.strictEqual(readPendingOp(state, '/project-a'), undefined);
    assert.deepStrictEqual(readPendingOp(state, '/project-b'), op);
  });

  test('clearPendingOp on last entry removes the key entirely', async () => {
    await writePendingOp(state, '/project', { kind: 'turn-off', workshopName: 'web' });
    await clearPendingOp(state, '/project');
    assert.strictEqual(state.get(PENDING_OPS_KEY), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveLocalProjectPath
// ---------------------------------------------------------------------------

suite('resolveLocalProjectPath', () => {
  let state: MemoryMemento;

  setup(() => { state = new MemoryMemento(); });

  test('returns undefined when folder is undefined', () => {
    assert.strictEqual(resolveLocalProjectPath(undefined, state), undefined);
  });

  test('returns fsPath for a local file:// folder', () => {
    assert.strictEqual(
      resolveLocalProjectPath(localFolder('/home/user/project'), state),
      '/home/user/project',
    );
  });

  test('returns localProjectPath from session for an SSH folder', async () => {
    await writeSession(state, 'web.proj-1.wp', { localProjectPath: '/host/project', workshopName: 'web' });
    assert.strictEqual(
      resolveLocalProjectPath(sshFolder('web.proj-1.wp'), state),
      '/host/project',
    );
  });

  test('returns undefined for SSH folder with no session', () => {
    assert.strictEqual(
      resolveLocalProjectPath(sshFolder('web.proj-1.wp'), state),
      undefined,
    );
  });
});
