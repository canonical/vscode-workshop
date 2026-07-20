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
    const session: WorkshopSession = { projectId: 'proj-1', workshopName: 'web' };
    await writeSession(state, 'web.proj-1.wp', session);
    assert.deepStrictEqual(readSession(state, 'web.proj-1.wp'), session);
  });

  test('writeSession does not clobber other hostnames', async () => {
    const s1: WorkshopSession = { projectId: 'proj-1', workshopName: 'web' };
    const s2: WorkshopSession = { projectId: 'proj-2', workshopName: 'api' };
    await writeSession(state, 'host-1.wp', s1);
    await writeSession(state, 'host-2.wp', s2);
    assert.deepStrictEqual(readSession(state, 'host-1.wp'), s1);
    assert.deepStrictEqual(readSession(state, 'host-2.wp'), s2);
  });

  test('clearSession removes the hostname entry', async () => {
    await writeSession(state, 'web.proj-1.wp', { projectId: 'proj-1', workshopName: 'web' });
    await clearSession(state, 'web.proj-1.wp');
    assert.strictEqual(readSession(state, 'web.proj-1.wp'), undefined);
  });

  test('clearSession leaves other hostnames intact', async () => {
    const s1: WorkshopSession = { projectId: 'proj-1', workshopName: 'web' };
    const s2: WorkshopSession = { projectId: 'proj-2', workshopName: 'api' };
    await writeSession(state, 'host-1.wp', s1);
    await writeSession(state, 'host-2.wp', s2);
    await clearSession(state, 'host-1.wp');
    assert.strictEqual(readSession(state, 'host-1.wp'), undefined);
    assert.deepStrictEqual(readSession(state, 'host-2.wp'), s2);
  });

  test('clearSession on last entry removes the key entirely', async () => {
    await writeSession(state, 'web.proj-1.wp', { projectId: 'proj-1', workshopName: 'web' });
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
    assert.strictEqual(readPendingOp(state, 'proj-1'), undefined);
  });

  test('writePendingOp persists op keyed by projectId', async () => {
    const op: PendingOperation = { kind: 'refresh', workshopName: 'web', projectId: 'proj-1', mode: 'continue' };
    await writePendingOp(state, 'proj-1', op);
    assert.deepStrictEqual(readPendingOp(state, 'proj-1'), op);
  });

  test('writePendingOp does not clobber other projects', async () => {
    const op1: PendingOperation = { kind: 'refresh', workshopName: 'web', projectId: 'proj-1', mode: 'continue' };
    const op2: PendingOperation = { kind: 'turn-off', workshopName: 'api', projectId: 'proj-2' };
    await writePendingOp(state, 'proj-1', op1);
    await writePendingOp(state, 'proj-2', op2);
    assert.deepStrictEqual(readPendingOp(state, 'proj-1'), op1);
    assert.deepStrictEqual(readPendingOp(state, 'proj-2'), op2);
  });

  test('clearPendingOp removes the project entry', async () => {
    await writePendingOp(state, 'proj-1', { kind: 'turn-off', workshopName: 'web', projectId: 'proj-1' });
    await clearPendingOp(state, 'proj-1');
    assert.strictEqual(readPendingOp(state, 'proj-1'), undefined);
  });

  test('clearPendingOp leaves other projects intact', async () => {
    const op: PendingOperation = { kind: 'turn-off', workshopName: 'api', projectId: 'proj-2' };
    await writePendingOp(state, 'proj-1', { kind: 'turn-off', workshopName: 'web', projectId: 'proj-1' });
    await writePendingOp(state, 'proj-2', op);
    await clearPendingOp(state, 'proj-1');
    assert.strictEqual(readPendingOp(state, 'proj-1'), undefined);
    assert.deepStrictEqual(readPendingOp(state, 'proj-2'), op);
  });

  test('clearPendingOp on last entry removes the key entirely', async () => {
    await writePendingOp(state, 'proj-1', { kind: 'turn-off', workshopName: 'web', projectId: 'proj-1' });
    await clearPendingOp(state, 'proj-1');
    assert.strictEqual(state.get(PENDING_OPS_KEY), undefined);
  });
});
