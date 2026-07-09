import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { WorkshopClient } from '../api/client';
import { refreshAndReopen } from '../remote/refresh';
import { Workshop } from '../api/workshops';

// ---------------------------------------------------------------------------
// Helpers (mirrors reopen.test.ts)
// ---------------------------------------------------------------------------

type ExecuteCommand = typeof vscode.commands.executeCommand;
type MutableCommands = { executeCommand: ExecuteCommand };

interface CapturedCommand {
  command: string;
  args: unknown[];
}

async function captureCommands(body: () => Promise<void>): Promise<CapturedCommand[]> {
  const original = vscode.commands.executeCommand;
  const captured: CapturedCommand[] = [];
  (vscode.commands as MutableCommands).executeCommand = ((command: string, ...args: unknown[]) => {
    captured.push({ command, args });
    return Promise.resolve(undefined);
  }) as ExecuteCommand;
  try {
    await body();
  } finally {
    (vscode.commands as MutableCommands).executeCommand = original;
  }
  return captured;
}

/**
 * Start a minimal fake workshopd for refresh tests.
 *
 * `refreshStatus` controls what the poll loop returns:
 *   - `'Done'` — successful refresh, `ready: true`
 *   - `'Wait'` — paused mid-refresh (wait-on-error), `ready: false, status: 'Wait'`
 *   - `'Error'` — failed refresh, `ready: true, err: 'build failed'`
 */
function startFakeDaemon(
  socketPath: string,
  opts: {
    refreshStatus: 'Done' | 'Wait' | 'Error';
    captureBody?: (body: unknown) => void;
  },
): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const sync = (result: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
    };
    const async202 = (change: string, result: unknown) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'async', 'status-code': 202, change, result }));
    };

    // POST /v1/projects
    if (req.method === 'POST' && req.url === '/v1/projects') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => sync({ id: 'proj-1', path: JSON.parse(Buffer.concat(chunks).toString()).path }));
      return;
    }

    // GET /v1/projects/proj-1/workshops/web (single workshop, for connect step)
    if (req.method === 'GET' && req.url === '/v1/projects/proj-1/workshops/web') {
      sync({ 'project-id': 'proj-1', name: 'web', status: 'ready', hostname: 'web.proj-1.wp' });
      return;
    }

    // POST /v1/projects/proj-1/workshops (refresh action)
    if (req.method === 'POST' && req.url === '/v1/projects/proj-1/workshops') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        opts.captureBody?.(body);
        async202('20', null);
      });
      return;
    }

    // GET /v1/changes/20 (verbose poll — no /wait suffix)
    if (req.method === 'GET' && /\/v1\/changes\/20(\?.*)?$/.test(req.url ?? '')) {
      const tasks = [{ id: 't1', kind: 'build', summary: 'Building image', status: 'Done', log: ['step 1', 'step 2'] }];
      if (opts.refreshStatus === 'Done') {
        sync({ id: '20', kind: 'refresh', status: 'Done', ready: true, tasks });
      } else if (opts.refreshStatus === 'Wait') {
        // A paused wait-on-error refresh: a task is parked in Wait, unable to
        // run, and the change parked in Wait alongside it.
        const failed = [
          ...tasks,
          { id: 't2', kind: 'hook', summary: 'Run hook "setup-base" for "oc" SDK', status: 'Wait', log: ['boom'] },
        ];
        sync({ id: '20', kind: 'refresh', status: 'Wait', ready: false, tasks: failed });
      } else {
        sync({ id: '20', kind: 'refresh', status: 'Error', ready: true, err: 'build failed', tasks });
      }
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('refreshAndReopen', () => {
  let socketPath: string;

  setup(() => {
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')), 'workshop.socket');
  });

  test('POSTs refresh with mode:wait-on-error and connects on success', async () => {
    const capturedBodies: unknown[] = [];
    const server = await startFakeDaemon(socketPath, {
      refreshStatus: 'Done',
      captureBody: (b) => capturedBodies.push(b),
    });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      const commands = await captureCommands(() => refreshAndReopen(client, '/repo', workshop));

      // Verify the action body
      assert.strictEqual(capturedBodies.length, 1, 'exactly one POST');
      const body = capturedBodies[0] as { action: string; options: { mode: string } };
      assert.strictEqual(body.action, 'refresh');
      assert.strictEqual(body.options?.mode, 'wait-on-error');

      // Verify it connected afterwards
      const openFolder = commands.find((c) => c.command === 'vscode.openFolder');
      assert.ok(openFolder, 'vscode.openFolder was called');
      const uri = (openFolder.args[0] as vscode.Uri).toString();
      assert.ok(uri.includes('web.proj-1.wp'), `URI has hostname: ${uri}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('streams verbose log lines via onLog callback', async () => {
    const server = await startFakeDaemon(socketPath, { refreshStatus: 'Done' });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };
      const logLines: string[] = [];

      await captureCommands(() =>
        refreshAndReopen(client, '/repo', workshop, { onLog: (lines) => logLines.push(...lines) }),
      );

      assert.ok(logLines.length > 0, 'log lines were emitted');
      assert.ok(logLines.includes('step 1'), `expected "step 1" in logs, got: ${logLines.join(', ')}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('connects when onPause returns debug', async () => {
    const server = await startFakeDaemon(socketPath, { refreshStatus: 'Wait' });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      // onPause returns 'debug' → connect for debugging.
      const commands = await captureCommands(() =>
        refreshAndReopen(client, '/repo', workshop, { onPause: () => Promise.resolve('debug') }),
      );

      const openFolder = commands.find((c) => c.command === 'vscode.openFolder');
      assert.ok(openFolder, "connected after onPause resolved 'debug'");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('passes the waiting task descriptions to onPause', async () => {
    const server = await startFakeDaemon(socketPath, { refreshStatus: 'Wait' });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      let received: string | undefined;
      await captureCommands(() =>
        refreshAndReopen(client, '/repo', workshop, {
          onPause: (error) => {
            received = error;
            return Promise.resolve('dismiss');
          },
        }),
      );

      assert.strictEqual(
        received,
        'Cannot perform the following tasks:\n  - Run hook "setup-base" for "oc" SDK',
        'onPause received the bulleted waiting-task descriptions',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('does not connect when onPause returns dismiss', async () => {
    const server = await startFakeDaemon(socketPath, { refreshStatus: 'Wait' });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      // onPause returns 'dismiss' → do nothing.
      const commands = await captureCommands(() =>
        refreshAndReopen(client, '/repo', workshop, { onPause: () => Promise.resolve('dismiss') }),
      );

      const openFolder = commands.find((c) => c.command === 'vscode.openFolder');
      assert.strictEqual(openFolder, undefined, "should not connect when onPause resolves 'dismiss'");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('runs an abort action and does not connect when onPause returns abort', async () => {
    const capturedBodies: unknown[] = [];
    const server = await startFakeDaemon(socketPath, {
      refreshStatus: 'Wait',
      captureBody: (b) => capturedBodies.push(b),
    });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      // onPause returns 'abort' → unwind the paused refresh, stay local.
      const commands = await captureCommands(() =>
        refreshAndReopen(client, '/repo', workshop, { onPause: () => Promise.resolve('abort') }),
      );

      // Two POSTs: the initial wait-on-error refresh, then the abort.
      const modes = capturedBodies.map((b) => (b as { options?: { mode?: string } }).options?.mode);
      assert.deepStrictEqual(modes, ['wait-on-error', 'abort']);

      const openFolder = commands.find((c) => c.command === 'vscode.openFolder');
      assert.strictEqual(openFolder, undefined, 'an abort stays local and does not connect');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('does not connect when no onPause is provided on pause', async () => {
    const server = await startFakeDaemon(socketPath, { refreshStatus: 'Wait' });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      const commands = await captureCommands(() => refreshAndReopen(client, '/repo', workshop));

      const openFolder = commands.find((c) => c.command === 'vscode.openFolder');
      assert.strictEqual(openFolder, undefined, 'a paused refresh without onPause does not connect');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('throws on refresh error', async () => {
    const server = await startFakeDaemon(socketPath, { refreshStatus: 'Error' });
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready' };

      await assert.rejects(
        () => captureCommands(() => refreshAndReopen(client, '/repo', workshop)),
        (err: Error) => err.message.includes('build failed'),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
