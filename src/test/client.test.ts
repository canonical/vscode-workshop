import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { WorkshopClient, WorkshopUnavailableError } from '../api/client';
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

  setup(async () => {
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
    const workshops = await listProjectWorkshops(client, '/repo');

    assert.deepStrictEqual(workshops, [
      { name: 'db', status: 'Off', definitionPath: '/repo/.workshop/db.yaml' },
      { name: 'web', status: 'On', rawStatus: 'ready', hostname: undefined, definitionPath: '/repo/.workshop/web.yaml' },
    ]);
  });

  test('errors from the daemon reject with a message', async () => {
    const client = new WorkshopClient({ socketPath });
    await assert.rejects(() => client.listWorkshops('missing'), /not found/);
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
    const resolved = defaultSocketPath({ WORKSHOP_SOCKET: '/nope/missing.socket' });
    assert.strictEqual(resolved, '/nope/missing.socket');
  });
});
