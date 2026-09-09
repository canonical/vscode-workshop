import * as assert from 'assert';

import { Change, WorkshopApiError, WorkshopsResponse, WorkshopInfo } from '../api/client';
import { ConnectionsSnapshot } from '../api/connections';
import { fetchPanelData, MountsClient, MountsDataDeps } from '../mounts/data';
import { InflightTracker } from '../mounts/inflight';
import {
  MSG_LOADING,
  MSG_NO_SELECTION,
  MSG_NO_WORKSHOPS,
  MSG_OFF,
  pendingMessage,
  workshopGoneMessage,
} from '../mounts/panelState';

const P = 'p1';

function plugRef(workshop: string, sdk: string, name: string) {
  return { 'project-id': P, workshop, sdk, plug: name };
}

function slotRef(workshop: string, sdk: string, name: string) {
  return { 'project-id': P, workshop, sdk, slot: name };
}

interface StubConfig {
  response?: WorkshopsResponse;
  details?: Record<string, WorkshopInfo | WorkshopApiError>;
  connections?: Record<string, ConnectionsSnapshot | WorkshopApiError>;
  changes?: Change[];
}

class StubClient implements MountsClient {
  calls: string[] = [];

  constructor(private readonly config: StubConfig) {}

  async listWorkshops(projectId: string): Promise<WorkshopsResponse> {
    this.calls.push(`listWorkshops:${projectId}`);
    return this.config.response ?? {};
  }

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

  async listChanges(options?: { select?: string; projectId?: string }): Promise<Change[]> {
    this.calls.push(`listChanges:${options?.select}:${options?.projectId}`);
    return this.config.changes ?? [];
  }
}

function makeDeps(config: StubConfig, overrides?: Partial<MountsDataDeps>): {
  deps: MountsDataDeps;
  client: StubClient;
  inflight: InflightTracker;
} {
  const client = new StubClient(config);
  const inflight = new InflightTracker();
  return {
    deps: {
      client,
      inflight,
      ...overrides,
    },
    client,
    inflight,
  };
}

const DEV_READY: WorkshopsResponse = {
  workshops: [{ 'project-id': P, name: 'dev', status: 'ready' }],
  files: [{ 'project-id': P, name: 'dev', path: '/defs/dev.yaml' }],
};

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
      response: DEV_READY,
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

  test('no workshops → the no-workshops message', async () => {
    const { deps } = makeDeps({ response: {} });
    const data = await fetchPanelData(deps, P, undefined);
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_NO_WORKSHOPS });
  });

  test('workshops exist but none is selected → the no-selection message', async () => {
    const { deps, client } = makeDeps({ response: DEV_READY });
    const data = await fetchPanelData(deps, P, undefined);
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_NO_SELECTION });
    assert.ok(!client.calls.some((c) => c.startsWith('getWorkshop') || c.startsWith('getConnections')));
  });

  test('a vanished selection keeps its name and shows the gone message', async () => {
    const { deps } = makeDeps({
      response: {
        workshops: [
          { 'project-id': P, name: 'a', status: 'ready' },
          { 'project-id': P, name: 'b', status: 'ready' },
        ],
      },
      details: {},
      connections: {},
    });
    const data = await fetchPanelData(deps, P, 'gone');
    assert.deepStrictEqual(data.body, { kind: 'message', text: workshopGoneMessage('gone') });
  });

  test('an Off workshop shows the Off message without touching live endpoints', async () => {
    const { deps, client } = makeDeps({
      response: { files: [{ 'project-id': P, name: 'dev', path: '/defs/dev.yaml' }] },
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_OFF });
    assert.ok(!client.calls.some((c) => c.startsWith('getWorkshop') || c.startsWith('getConnections')));
  });

  test('Pending matched to a lifecycle change blanks the tab with that kind', async () => {
    const { deps, client } = makeDeps({
      response: { workshops: [{ 'project-id': P, name: 'dev', status: 'pending' }] },
      changes: [{ id: 'c1', kind: 'launch', summary: 'Launch workshop "dev"', status: 'Doing', ready: false }],
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: pendingMessage('launch') });
    assert.ok(client.calls.includes(`listChanges:in-progress:${P}`));
    assert.ok(!client.calls.some((c) => c.startsWith('getConnections')));
  });

  test('Pending from a row-op keeps the table live (AC 18)', async () => {
    const { deps } = makeDeps({
      response: { workshops: [{ 'project-id': P, name: 'dev', status: 'pending' }], files: DEV_READY.files },
      details: { dev: DEV_DETAIL },
      connections: { dev: DEV_SNAPSHOT },
      changes: [{ id: 'c1', kind: 'disconnect', summary: 'Disconnect dev/node:npm-cache from dev/system:mount', status: 'Doing', ready: false }],
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.strictEqual(data.body.kind, 'table', 'row-level changes never blank the tab');
  });

  test('Pending matching nothing fetches live state rather than fabricating a task', async () => {
    const { deps } = makeDeps({
      response: { workshops: [{ 'project-id': P, name: 'dev', status: 'pending' }], files: DEV_READY.files },
      details: { dev: DEV_DETAIL },
      connections: { dev: DEV_SNAPSHOT },
      changes: [],
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.strictEqual(data.body.kind, 'table');
  });

  test('a 404 from the live endpoints degrades to Loading, not a poll failure', async () => {
    const { deps } = makeDeps({
      response: DEV_READY,
      details: { dev: new WorkshopApiError('not found', 404) },
      connections: { dev: DEV_SNAPSHOT },
    });
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: MSG_LOADING });
  });

  test('non-404 errors from live endpoints propagate to the poll error path', async () => {
    const { deps } = makeDeps({
      response: DEV_READY,
      details: { dev: new WorkshopApiError('boom', 500) },
      connections: { dev: DEV_SNAPSHOT },
    });
    await assert.rejects(() => fetchPanelData(deps, P, 'dev'), /boom/);
  });

  test('a guided remount blanks the tab regardless of status', async () => {
    const { deps, inflight, client } = makeDeps({
      response: { workshops: [{ 'project-id': P, name: 'dev', status: 'pending' }] },
    });
    inflight.beginGuidedRemount(P, 'dev');
    const data = await fetchPanelData(deps, P, 'dev');
    assert.deepStrictEqual(data.body, { kind: 'message', text: pendingMessage('remount') });
    assert.ok(!client.calls.some((c) => c.startsWith('listChanges')), 'no change matching needed');
  });
});
