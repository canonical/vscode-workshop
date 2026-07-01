import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

import { WebSocketServer, WebSocket } from 'ws';

import { WorkshopClient } from '../api/client';
import { reopenInWorkshop } from '../remote/reopen';
import { Workshop } from '../api/workshops';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecuteCommand = typeof vscode.commands.executeCommand;
type MutableCommands = { executeCommand: ExecuteCommand };

interface CapturedCommand {
  command: string;
  args: unknown[];
}

/**
 * Intercept every `vscode.commands.executeCommand` call while `body` runs.
 * Replaces `vscode.openFolder` so the window does not actually reopen.
 */
async function captureCommands(body: () => Promise<void>): Promise<CapturedCommand[]> {
  const original = vscode.commands.executeCommand;
  const captured: CapturedCommand[] = [];

  (vscode.commands as MutableCommands).executeCommand = ((
    command: string,
    ...args: unknown[]
  ) => {
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
 * Build a minimal fake workshopd that handles the exec + wait endpoints used
 * by `ensureSshAccess`, plus optional `start`/`launch` action + wait.
 */
function startFakeDaemon(
  socketPath: string,
  opts: { actionChange?: string; workshops?: unknown[] },
): Promise<{ server: http.Server; wss: WebSocketServer }> {
  const server = http.createServer((req, res) => {
    const sync = (result: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
    };

    const async202 = (change: string, result: unknown) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'async', 'status-code': 202, change, result }));
    };

    // POST /v1/projects → project
    if (req.method === 'POST' && req.url === '/v1/projects') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => sync({ id: 'proj-1', path: JSON.parse(Buffer.concat(chunks).toString()).path }));
      return;
    }

    // GET /v1/projects/proj-1/workshops/web → single workshop info with hostname
    if (req.method === 'GET' && req.url === '/v1/projects/proj-1/workshops/web') {
      sync({ 'project-id': 'proj-1', name: 'web', status: 'ready', hostname: 'web.proj-1.wp', base: '' });
      return;
    }

    // GET /v1/projects/proj-1/workshops?state=available → list (kept for compat)
    if (req.method === 'GET' && req.url?.startsWith('/v1/projects/proj-1/workshops?')) {
      sync({ workshops: opts.workshops ?? [{ 'project-id': 'proj-1', name: 'web', status: 'ready', hostname: 'web.proj-1.wp' }] });
      return;
    }

    // POST /v1/projects/proj-1/workshops → action (start/launch)
    if (req.method === 'POST' && req.url === '/v1/projects/proj-1/workshops') {
      const change = opts.actionChange ?? '10';
      async202(change, null);
      return;
    }

    // GET /v1/changes/*/wait
    if (req.method === 'GET' && req.url?.includes('/wait')) {
      const id = req.url.match(/\/v1\/changes\/([^/]+)\/wait/)?.[1] ?? '1';
      sync({ id, kind: 'exec', status: 'Done', ready: true, tasks: [{ id: '1', kind: 'exec', status: 'Done', data: { 'exit-code': 0 } }] });
      return;
    }

    // POST /v1/projects/proj-1/workshops/web/exec
    if (req.method === 'POST' && req.url?.endsWith('/exec')) {
      async202('99', { 'task-id': 'T1' });
      return;
    }

    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
    if (req.url?.endsWith('/stdout') || req.url?.endsWith('/stderr')) {
      socket.send('');
    }
  });

  return new Promise((resolve) => server.listen(socketPath, () => resolve({ server, wss })));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('reopenInWorkshop', () => {
  let tmpDir: string;
  let socketPath: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-reopen-'));
    socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')), 'workshop.socket');
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('calls openFolder with ssh-remote URI and forceReuseWindow for a running workshop', async () => {
    const { server, wss } = await startFakeDaemon(socketPath, {});
    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'On', rawStatus: 'ready', hostname: 'web.proj-1.wp' };

      const commands = await captureCommands(() =>
        reopenInWorkshop(client, '/repo', workshop, tmpDir),
      );

      const openFolder = commands.find((c) => c.command === 'vscode.openFolder');
      assert.ok(openFolder, 'vscode.openFolder was called');
      const uri = openFolder.args[0] as vscode.Uri;
      const uriStr = uri.toString();
      assert.ok(uriStr.includes('web.proj-1.wp'), `URI contains hostname, got: ${uriStr}`);
      assert.ok(uriStr.includes('ssh-remote'), `URI uses ssh-remote scheme, got: ${uriStr}`);
      assert.deepStrictEqual(openFolder.args[1], { forceReuseWindow: true });
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('calls the start action before connecting for a stopped workshop', async () => {
    const actionBodies: unknown[] = [];
    const originalCreate = http.createServer.bind(http);
    // We need to capture the action body — use a wrapper server.
    const { server, wss } = await startFakeDaemon(socketPath, { actionChange: '10' });

    // Monkey-patch to capture POST /workshops body.
    const origListen = server.listeners('request')[0] as http.RequestListener;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/projects/proj-1/workshops') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          actionBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        });
      }
      origListen(req, res);
    });

    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'Off', rawStatus: 'stopped' };

      await captureCommands(() => reopenInWorkshop(client, '/repo', workshop, tmpDir));

      assert.ok(actionBodies.length > 0, 'a lifecycle action was POSTed');
      const body = actionBodies[0] as { action: string; names: string[] };
      assert.strictEqual(body.action, 'start');
      assert.deepStrictEqual(body.names, ['web']);
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('calls the launch action for a definition-only workshop', async () => {
    const actionBodies: unknown[] = [];
    const { server, wss } = await startFakeDaemon(socketPath, { actionChange: '11' });

    const origListen = server.listeners('request')[0] as http.RequestListener;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/projects/proj-1/workshops') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => actionBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }
      origListen(req, res);
    });

    try {
      const client = new WorkshopClient({ socketPath });
      const workshop: Workshop = { name: 'web', status: 'Off' }; // definition-only

      await captureCommands(() => reopenInWorkshop(client, '/repo', workshop, tmpDir));

      assert.ok(actionBodies.length > 0, 'a lifecycle action was POSTed');
      const body = actionBodies[0] as { action: string };
      assert.strictEqual(body.action, 'launch');
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
