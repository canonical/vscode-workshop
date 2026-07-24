import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { WorkshopClient, WorkshopApiError, WorkshopUnavailableError } from '../api/client';
import {
  DEFAULT_SOCKET_PATH,
  SNAP_SOCKET_PATH,
  defaultSocketPath,
  socketPathCandidates,
} from '../api/client';
import { listProjectWorkshops } from '../api/workshops';

suite('WorkshopClient over a fake workshopd socket', () => {
  let server: http.Server;
  let socketPath: string;
  let projectPostCount: number;

  setup(async () => {
    projectPostCount = 0;
    socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')),
      'workshop.socket',
    );

    server = http.createServer((req, res) => {
      const sync = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'sync', 'status-code': 200, status: 'OK', result }));
      };

      if (req.method === 'POST' && req.url === '/v1/projects') {
        projectPostCount += 1;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          sync({ id: 'proj-1', path: body.path });
        });
        return;
      }

      if (
        req.method === 'GET' &&
        req.url === '/v1/projects/proj-1/workshops?state=available'
      ) {
        sync({
          workshops: [{ 'project-id': 'proj-1', name: 'web', status: 'ready' }],
          files: [
            { 'project-id': 'proj-1', name: 'web', path: '/repo/.workshop/web.yaml' },
            { 'project-id': 'proj-1', name: 'db', path: '/repo/.workshop/db.yaml' },
          ],
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', 'status-code': 404, result: { message: 'not found' } }));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  teardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('listProjectWorkshops resolves the project and merges results', async () => {
    const client = new WorkshopClient({ socketPath });
    const project = await client.ensureProject('/repo');
    const workshops = await listProjectWorkshops(client, project.id);

    assert.deepStrictEqual(workshops, [
      { name: 'db', status: 'Off', definitionPath: '/repo/.workshop/db.yaml', projectId: 'proj-1' },
      { name: 'web', status: 'On', rawStatus: 'ready', hostname: undefined, definitionPath: '/repo/.workshop/web.yaml', projectId: 'proj-1' },
    ]);
  });

  test('errors from the daemon reject with a message', async () => {
    const client = new WorkshopClient({ socketPath });
    await assert.rejects(() => client.listWorkshops('missing'), /not found/);
  });

  test('ensureProject memoizes the project by path', async () => {
    const client = new WorkshopClient({ socketPath });

    const a = await client.ensureProject('/repo');
    const b = await client.ensureProject('/repo');

    assert.deepStrictEqual(a, b);
    assert.strictEqual(projectPostCount, 1, 'the project is resolved only once');

    // A different path resolves (and POSTs) independently.
    await client.ensureProject('/other');
    assert.strictEqual(projectPostCount, 2);
  });
});

suite('workshopAction — refresh body serialization', () => {
  let server: http.Server;
  let socketPath: string;
  let capturedBody: Record<string, unknown> | undefined;
  let changeStatus: string;

  setup(async () => {
    capturedBody = undefined;
    changeStatus = 'Done';
    socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')),
      'workshop.socket',
    );

    server = http.createServer((req, res) => {
      const sync = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
      };
      const async202 = (changeId: string) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'async', 'status-code': 202, change: changeId, result: null }));
      };

      if (req.method === 'POST' && req.url === '/v1/projects/proj-1/workshops') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          async202('chg-1');
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/changes/chg-1/wait') {
        sync({ id: 'chg-1', kind: 'refresh', status: changeStatus, ready: true });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', 'status-code': 404, result: { message: 'not found' } }));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  teardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('sends action=refresh with wait-on-error mode and verbose=true', async () => {
    const client = new WorkshopClient({ socketPath });
    const change = await client.workshopAction('proj-1', ['web'], 'refresh', {
      mode: 'wait-on-error',
      verbose: true,
    });

    assert.deepStrictEqual(capturedBody, {
      names: ['web'],
      action: 'refresh',
      options: { mode: 'wait-on-error', verbose: true },
    });
    assert.strictEqual(change.status, 'Done');
  });

  test('sends action=start without options when no options provided', async () => {
    const client = new WorkshopClient({ socketPath });
    await client.workshopAction('proj-1', ['web'], 'start');
    assert.deepStrictEqual(capturedBody, { names: ['web'], action: 'start' });
  });

  test('does not throw when mode is wait-on-error and change status is Wait', async () => {
    changeStatus = 'Wait';
    const client = new WorkshopClient({ socketPath });
    // Fake a Wait response with an err field (daemon sets err when pausing).
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const sync = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
      };
      const async202 = (changeId: string) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'async', 'status-code': 202, change: changeId, result: null }));
      };
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => { async202('chg-1'); });
        return;
      }
      if (req.method === 'GET' && req.url?.includes('/wait')) {
        sync({ id: 'chg-1', kind: 'refresh', status: 'Wait', ready: true, err: 'paused' });
        return;
      }
      res.writeHead(404); res.end();
    });
    const change = await client.workshopAction('proj-1', ['web'], 'refresh', { mode: 'wait-on-error' });
    assert.strictEqual(change.status, 'Wait');
  });

  test('throws WorkshopApiError on Wait when mode is not wait-on-error', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const sync = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
      };
      const async202 = (changeId: string) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'async', 'status-code': 202, change: changeId, result: null }));
      };
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => { async202('chg-1'); });
        return;
      }
      if (req.method === 'GET' && req.url?.includes('/wait')) {
        sync({ id: 'chg-1', kind: 'refresh', status: 'Wait', ready: true, err: 'paused' });
        return;
      }
      res.writeHead(404); res.end();
    });
    const client = new WorkshopClient({ socketPath });
    await assert.rejects(
      () => client.workshopAction('proj-1', ['web'], 'refresh'),
      (err: unknown) => { assert.ok(err instanceof WorkshopApiError); return true; },
    );
  });

  test('throws WorkshopApiError when the change errors', async () => {
    changeStatus = 'Error';
    // Override the wait handler to include an err field.
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const sync = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'sync', 'status-code': 200, result }));
      };
      const async202 = (changeId: string) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'async', 'status-code': 202, change: changeId, result: null }));
      };
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => { async202('chg-1'); });
        return;
      }
      if (req.method === 'GET' && req.url?.includes('/wait')) {
        sync({ id: 'chg-1', kind: 'refresh', status: 'Error', ready: true, err: 'build failed' });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new WorkshopClient({ socketPath });
    await assert.rejects(
      () => client.workshopAction('proj-1', ['web'], 'refresh'),
      (err: unknown) => {
        assert.ok(err instanceof WorkshopApiError);
        assert.match(err.message, /build failed/);
        return true;
      },
    );
  });
});

suite('WorkshopClient when workshopd is not available', () => {
  test('rejects with WorkshopUnavailableError when the socket is missing', async () => {
    const missingSocket = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')),
      'does-not-exist.socket',
    );
    const client = new WorkshopClient({ socketPath: missingSocket });

    await assert.rejects(
      () => client.ensureProject('/repo'),
      (err: unknown) => {
        assert.ok(err instanceof WorkshopUnavailableError);
        assert.strictEqual(err.code, 'ENOENT');
        return true;
      },
    );
  });
});

suite('socket path resolution', () => {
  test('candidates default to the snap path before the system default', () => {
    assert.deepStrictEqual(socketPathCandidates({}), [SNAP_SOCKET_PATH, DEFAULT_SOCKET_PATH]);
  });

  test('$WORKSHOP_SOCKET and $WORKSHOP take precedence, in order, without duplicates', () => {
    const candidates = socketPathCandidates({
      WORKSHOP_SOCKET: '/custom/explicit.socket',
      WORKSHOP: '/opt/workshop',
    });
    assert.deepStrictEqual(candidates, [
      '/custom/explicit.socket',
      '/opt/workshop/workshop.socket',
      SNAP_SOCKET_PATH,
      DEFAULT_SOCKET_PATH,
    ]);
  });

  test('defaultSocketPath returns the first candidate that exists on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-'));
    const existing = path.join(dir, 'workshop.socket');
    fs.writeFileSync(existing, '');

    const resolved = defaultSocketPath({ WORKSHOP_SOCKET: '/nope/missing.socket', WORKSHOP: dir });
    assert.strictEqual(resolved, existing);
  });

  test('defaultSocketPath falls back to the first candidate when none exist', () => {
    // Real candidates (SNAP_SOCKET_PATH, DEFAULT_SOCKET_PATH) may actually
    // exist on a machine with workshop installed, so the existence check is
    // stubbed to simulate a machine with no daemon socket present anywhere.
    const resolved = defaultSocketPath({ WORKSHOP_SOCKET: '/nope/missing.socket' }, () => false);
    assert.strictEqual(resolved, '/nope/missing.socket');
  });
});
