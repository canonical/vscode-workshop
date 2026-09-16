import * as assert from 'assert';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import {
  isChangeConflict,
  WorkshopApiError,
  WorkshopClient,
} from '../api/client';
import {
  attrString,
  displayKey,
  isHostSlot,
  makeSlotRef,
  normalizeConnections,
  plugKey,
  slotKey,
  SYSTEM_SDK,
} from '../api/connections';

const REF = { 'project-id': 'p1', workshop: 'dev' };
const PLUG = { ...REF, sdk: 'node', plug: 'npm-cache' };
const HOST_SLOT = { ...REF, sdk: 'system', slot: 'mount' };
const SDK_SLOT = { ...REF, sdk: 'uv', slot: 'venv' };

suite('normalizeConnections', () => {
  test('normalizes a daemon-shaped snapshot, keeping attrs verbatim', () => {
    // Shape captured live from workshopd 0.9.5 (see Stage 1 curl capture).
    const snapshot = normalizeConnections({
      established: [{
        slot: HOST_SLOT,
        plug: PLUG,
        interface: 'mount',
        manual: true,
        'plug-attrs': { 'workshop-target': '/home/workshop/.npm/_cacache', mode: 509, uid: 1000 },
      }],
      undesired: [{ slot: HOST_SLOT, plug: { ...REF, sdk: 'uv', plug: 'cache' }, interface: 'mount', manual: true }],
      plugs: [{ ...PLUG, interface: 'mount', attrs: { 'workshop-target': '/x' }, connections: [HOST_SLOT] }],
      slots: [
        { ...HOST_SLOT, interface: 'mount', connections: [PLUG] },
        { ...SDK_SLOT, interface: 'mount', attrs: { 'workshop-source': '/home/workshop/uv-venv' } },
      ],
    });

    assert.strictEqual(snapshot.established.length, 1);
    assert.strictEqual(snapshot.undesired.length, 1);
    assert.strictEqual(snapshot.plugs.length, 1);
    assert.strictEqual(snapshot.slots.length, 2);
    assert.strictEqual(
      attrString(snapshot.established[0]['plug-attrs'], 'workshop-target'),
      '/home/workshop/.npm/_cacache',
    );
    assert.strictEqual(snapshot.established[0].manual, true);
    assert.deepStrictEqual(snapshot.plugs[0].connections, [HOST_SLOT]);
  });

  test('missing arrays become empty (undesired is omitempty on the wire)', () => {
    assert.deepStrictEqual(normalizeConnections({ established: [], plugs: [], slots: [] }), {
      established: [],
      undesired: [],
      plugs: [],
      slots: [],
    });
    assert.deepStrictEqual(normalizeConnections({}), {
      established: [],
      undesired: [],
      plugs: [],
      slots: [],
    });
    assert.deepStrictEqual(normalizeConnections(null), {
      established: [],
      undesired: [],
      plugs: [],
      slots: [],
    });
  });

  test('malformed entries are dropped, not fatal', () => {
    const snapshot = normalizeConnections({
      established: [
        { slot: HOST_SLOT, plug: PLUG },
        { slot: HOST_SLOT }, // no plug ref
        { slot: 'system:mount', plug: PLUG }, // slot not an object ref
        42,
        null,
      ],
      plugs: [PLUG, { sdk: 'node' }, 'node:npm-cache'],
      slots: [HOST_SLOT, { ...REF, sdk: 'uv' }],
    });

    assert.strictEqual(snapshot.established.length, 1);
    assert.strictEqual(snapshot.plugs.length, 1);
    assert.strictEqual(snapshot.slots.length, 1);
  });

  test('helpers: keys, host slot, attrString, makeSlotRef', () => {
    assert.strictEqual(plugKey(PLUG), 'p1|dev|node|npm-cache');
    assert.strictEqual(slotKey(HOST_SLOT), 'p1|dev|system|mount');
    assert.strictEqual(displayKey(PLUG), 'node:npm-cache');
    assert.strictEqual(displayKey(HOST_SLOT), 'system:mount');
    assert.ok(isHostSlot(HOST_SLOT));
    assert.ok(!isHostSlot(SDK_SLOT));
    assert.strictEqual(attrString({ x: 5 }, 'x'), undefined);
    assert.strictEqual(attrString(undefined, 'x'), undefined);
    assert.deepStrictEqual(makeSlotRef('p1', 'dev', SYSTEM_SDK, 'mount'), HOST_SLOT);
  });
});

suite('connections API over a fake workshopd socket', () => {
  let server: http.Server;
  let socketPath: string;
  /** Every request seen: method, url, parsed body (for POSTs). */
  let requests: { method: string; url: string; body?: unknown }[];
  /** Handler the test installs; returns [status, envelope]. */
  let respond: (method: string, url: string, body: unknown) => [number, unknown];

  setup(async () => {
    requests = [];
    respond = () => [
      200,
      { type: 'sync', 'status-code': 200, result: {} },
    ];
    socketPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'workshopd-')),
      'workshop.socket',
    );

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text.length > 0 ? JSON.parse(text) : undefined;
        requests.push({ method: req.method ?? '', url: req.url ?? '', body });
        const [status, envelope] = respond(req.method ?? '', req.url ?? '', body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  teardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): WorkshopClient {
    return new WorkshopClient({ socketPath });
  }

  test('getConnections sends project-id, workshop, interface and select=all', async () => {
    respond = () => [200, {
      type: 'sync',
      'status-code': 200,
      result: { established: [{ slot: HOST_SLOT, plug: PLUG }], plugs: [PLUG], slots: [HOST_SLOT] },
    }];

    const snapshot = await client().getConnections('p1', 'dev');

    assert.strictEqual(
      requests[0].url,
      '/v1/connections?project-id=p1&workshop=dev&interface=mount&select=all',
    );
    assert.strictEqual(snapshot.established.length, 1);
    assert.deepStrictEqual(snapshot.undesired, []);
  });

  test('connectionsAction posts one pair, follows the 202 with a wait', async () => {
    respond = (method, url) => {
      if (method === 'POST' && url === '/v1/connections') {
        return [202, { type: 'async', 'status-code': 202, change: 'chg-7', result: null }];
      }
      return [200, {
        type: 'sync',
        'status-code': 200,
        result: { id: 'chg-7', kind: 'disconnect', status: 'Done', ready: true },
      }];
    };

    const change = await client().connectionsAction('disconnect', PLUG, HOST_SLOT);

    assert.deepStrictEqual(requests.map((r) => [r.method, r.url]), [
      ['POST', '/v1/connections'],
      ['GET', '/v1/changes/chg-7/wait'],
    ]);
    assert.deepStrictEqual(requests[0].body, {
      action: 'disconnect',
      plugs: [PLUG],
      slots: [HOST_SLOT],
    });
    assert.strictEqual(change.ready, true);
  });

  test('connectionsAction sends forget only when true', async () => {
    respond = (method, url) => {
      if (method === 'POST') {
        return [202, { type: 'async', 'status-code': 202, change: 'chg-8', result: null }];
      }
      return [200, {
        type: 'sync',
        'status-code': 200,
        result: { id: 'chg-8', kind: 'disconnect', status: 'Done', ready: true },
      }];
    };

    const c = client();
    await c.connectionsAction('disconnect', PLUG, HOST_SLOT, { forget: true });
    await c.connectionsAction('disconnect', PLUG, HOST_SLOT, { forget: false });
    await c.connectionsAction('connect', PLUG, HOST_SLOT);

    const posts = requests.filter((r) => r.method === 'POST').map((r) => r.body as Record<string, unknown>);
    assert.strictEqual(posts[0].forget, true);
    assert.ok(!('forget' in posts[1]), 'forget: false is omitted');
    assert.ok(!('forget' in posts[2]), 'absent forget is omitted');
  });

  test('connectionsAction surfaces a failed change as WorkshopApiError', async () => {
    respond = (method) => {
      if (method === 'POST') {
        return [202, { type: 'async', 'status-code': 202, change: 'chg-9', result: null }];
      }
      return [200, {
        type: 'sync',
        'status-code': 200,
        result: { id: 'chg-9', kind: 'connect', status: 'Error', ready: true, err: 'slot gone' },
      }];
    };

    await assert.rejects(
      () => client().connectionsAction('connect', PLUG, HOST_SLOT),
      (err: unknown) => err instanceof WorkshopApiError && err.message === 'slot gone',
    );
  });

  test('error kind propagates from the daemon envelope', async () => {
    respond = () => [409, {
      type: 'error',
      'status-code': 409,
      result: { message: 'workshop "dev" has "refresh" change in progress', kind: 'change-conflict' },
    }];

    await assert.rejects(
      () => client().connectionsAction('connect', PLUG, HOST_SLOT),
      (err: unknown) =>
        err instanceof WorkshopApiError && err.kind === 'change-conflict' && isChangeConflict(err),
    );
  });

  test('remountPlug posts action/plug/host-source and waits', async () => {
    respond = (method, url) => {
      if (method === 'POST' && url === '/v1/projects/p1/workshops/dev/mounts') {
        return [202, { type: 'async', 'status-code': 202, change: 'chg-10', result: null }];
      }
      return [200, {
        type: 'sync',
        'status-code': 200,
        result: { id: 'chg-10', kind: 'remount', status: 'Done', ready: true },
      }];
    };

    await client().remountPlug('p1', 'dev', PLUG, '/backups/data');

    assert.strictEqual(requests[0].url, '/v1/projects/p1/workshops/dev/mounts');
    assert.deepStrictEqual(requests[0].body, {
      action: 'remount',
      plug: PLUG,
      'host-source': '/backups/data',
    });
    assert.strictEqual(requests[1].url, '/v1/changes/chg-10/wait');
  });

  test('listChanges sends select and project-id, never a workshops filter', async () => {
    respond = () => [200, {
      type: 'sync',
      'status-code': 200,
      result: [{ id: '1', kind: 'launch', status: 'Doing', ready: false }],
    }];

    const c = client();
    const changes = await c.listChanges({ select: 'in-progress', projectId: 'p1' });
    await c.listChanges();

    assert.strictEqual(requests[0].url, '/v1/changes?select=in-progress&project-id=p1');
    assert.strictEqual(requests[1].url, '/v1/changes');
    assert.ok(!requests[0].url.includes('workshops'), 'workshops filter matches nothing upstream');
    assert.strictEqual(changes.length, 1);
  });
});

suite('isChangeConflict', () => {
  test('matches the typed kind', () => {
    assert.ok(isChangeConflict(new WorkshopApiError('busy', 409, 'change-conflict')));
  });

  test('matches the plain-400 conflict message from connections/mounts', () => {
    // These endpoints attach no kind — only the %q-quoted message.
    assert.ok(isChangeConflict(
      new WorkshopApiError('workshop "dev" has "disconnect" change in progress', 400),
    ));
  });

  test('rejects other errors', () => {
    assert.ok(!isChangeConflict(new WorkshopApiError('not found', 404)));
    assert.ok(!isChangeConflict(new WorkshopApiError("workshop 'dev' has 'x' change in progress", 400)));
    assert.ok(!isChangeConflict(new Error('workshop "dev" has "x" change in progress')));
  });
});
