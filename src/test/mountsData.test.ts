import * as assert from 'assert';

import { WorkshopApiError, WorkshopInfo } from '../api/client';
import { ConnectionsSnapshot } from '../api/connections';
import { fetchPanelData, MountsClient, MountsDataDeps } from '../interfaces/data';
import {
  MSG_LOADING,
  MSG_NO_SELECTION,
  MSG_OFF,
} from '../interfaces/panelState';

const P = 'p1';

function plugRef(workshop: string, sdk: string, name: string) {
  return { 'project-id': P, workshop, sdk, plug: name };
}

function slotRef(workshop: string, sdk: string, name: string) {
  return { 'project-id': P, workshop, sdk, slot: name };
}

interface StubConfig {
  details?: Record<string, WorkshopInfo | WorkshopApiError>;
  connections?: Record<string, ConnectionsSnapshot | WorkshopApiError>;
}

class StubClient implements MountsClient {
  calls: string[] = [];

  constructor(private readonly config: StubConfig) {}

  async getWorkshop(projectId: string, name: string): Promise<WorkshopInfo> {
    this.calls.push(`getWorkshop:${name}`);
    const detail = this.config.details?.[name];
    if (detail === undefined) {
      throw new WorkshopApiError('not found', 404);
    }
    if (detail instanceof WorkshopApiError) {
      throw detail;
    }
    return detail;
  }

  async getConnections(projectId: string, workshop: string): Promise<ConnectionsSnapshot> {
    this.calls.push(`getConnections:${workshop}`);
    const snapshot = this.config.connections?.[workshop];
    if (snapshot === undefined) {
      throw new WorkshopApiError('not found', 404);
    }
    if (snapshot instanceof WorkshopApiError) {
      throw snapshot;
    }
    return snapshot;
  }
}

function makeDeps(config: StubConfig, overrides?: Partial<MountsDataDeps>): {
  deps: MountsDataDeps;
  client: StubClient;
} {
  const client = new StubClient(config);
  return {
    deps: {
      client,
      ...overrides,
    },
    client,
  };
}

const DEV_DETAIL: WorkshopInfo = {
  'project-id': P,
  name: 'dev',
  status: 'ready',
  path: '/defs/dev.yaml',
  sdks: [
    { name: 'system', mounts: null },
    {
      name: 'node',
      mounts: [{
        plug: plugRef('dev', 'node', 'npm-cache'),
        'host-source': '/data/id/12345678/dev/mount/node/npm-cache',
        'workshop-target': '/home/workshop/.npm/_cacache',
      }],
    },
  ],
};

const DEV_PENDING: WorkshopInfo = { ...DEV_DETAIL, status: 'pending' };
const DEV_STOPPED: WorkshopInfo = { ...DEV_DETAIL, status: 'stopped' };

const DEV_SNAPSHOT: ConnectionsSnapshot = {
  established: [{
    plug: plugRef('dev', 'node', 'npm-cache'),
    slot: slotRef('dev', 'system', 'mount'),
    'plug-attrs': { 'workshop-target': '/home/workshop/.npm/_cacache' },
  }],
  undesired: [],
  plugs: [{ ...plugRef('dev', 'node', 'npm-cache'), attrs: { 'workshop-target': '/home/workshop/.npm/_cacache' } }],
  slots: [{ ...slotRef('dev', 'system', 'mount') }],
};

suite('fetchPanelData', () => {
  test('a launched workshop yields the table', async () => {
    const { deps } = makeDeps({
      details: { dev: DEV_DETAIL },
      connections: { dev: DEV_SNAPSHOT },
    });

    const data = await fetchPanelData(deps, P, 'dev');

    assert.strictEqual(data.body.kind, 'table');
    if (data.body.kind === 'table') {
      const row = data.body.sections[0].rows[0];
      assert.strictEqual(row.connected, true);
      assert.strictEqual(row.source, '/data/id/12345678/dev/mount/node/npm-cache');
      assert.strictEqual(row.sourceDisplay, '…/12345678/dev/mount/node/npm-cache');
    }
  });

  test('nothing selected → the no-selection message; no fetch', async () => {
    const { deps, client } = makeDeps({});
    const data = await fetchPanelData(deps, P, undefined);
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_NO_SELECTION });
    assert.deepStrictEqual(client.calls, []);
  });

  test('a name with no instance renders as Off (never launched or removed)', async () => {
    const { deps, client } = makeDeps({ details: {} }); // getWorkshop 404s
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_OFF });
    assert.ok(!client.calls.some((c) => c.startsWith('getConnections')), 'no live fetch for Off');
  });

  test('a stopped workshop renders as Off without touching the live endpoints', async () => {
    const { deps, client } = makeDeps({ details: { dev: DEV_STOPPED } });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_OFF });
    assert.ok(!client.calls.some((c) => c.startsWith('getConnections')));
  });

  test('a Pending workshop shows the table (mounts are returned while pending)', async () => {
    const { deps } = makeDeps({
      details: { dev: DEV_PENDING },
      connections: { dev: DEV_SNAPSHOT },
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.strictEqual(data.body.kind, 'table');
  });

  test('a 404 from getConnections degrades to Loading, not a poll failure', async () => {
    const { deps } = makeDeps({
      details: { dev: DEV_DETAIL },
      connections: { dev: new WorkshopApiError('not found', 404) },
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_LOADING });
  });

  test('non-404 errors propagate to the poll error path', async () => {
    const { deps } = makeDeps({ details: { dev: new WorkshopApiError('boom', 500) } });
    await assert.rejects(() => fetchPanelData(deps, P, 'dev'), /boom/);
  });
});
