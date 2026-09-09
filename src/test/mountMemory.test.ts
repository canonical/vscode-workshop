import * as assert from 'assert';

import { ConnectionEntry, ConnectionsSnapshot } from '../api/connections';
import { isBuilt } from '../api/workshops';
import {
  clearWorkshopMemory,
  MementoLike,
  memoryKey,
  pruneMemory,
  readWorkshopMemory,
  rememberLivePairings,
  rememberPairing,
} from '../mounts/memory';

class MemoryMemento implements MementoLike {
  private readonly store = new Map<string, unknown>();
  updates = 0;

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.updates += 1;
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
}

const P = 'p1';
const W = 'dev';

function plug(sdk: string, name: string) {
  return { 'project-id': P, workshop: W, sdk, plug: name };
}

function slot(sdk: string, name: string) {
  return { 'project-id': P, workshop: W, sdk, slot: name };
}

function snapshot(parts: Partial<ConnectionsSnapshot>): ConnectionsSnapshot {
  return { established: [], undesired: [], plugs: [], slots: [], ...parts };
}

const HOST_PAIR: ConnectionEntry = { plug: plug('node', 'npm-cache'), slot: slot('system', 'mount') };
const SDK_PAIR: ConnectionEntry = {
  plug: plug('jupyter', 'venv'),
  slot: slot('uv', 'venv'),
  'slot-attrs': { 'workshop-source': '/home/workshop/uv-venv' },
};

suite('mount wiring memory', () => {
  let memento: MemoryMemento;

  setup(() => {
    memento = new MemoryMemento();
  });

  test('remembers live pairings per channel, including CLI-made ones', async () => {
    await rememberLivePairings(memento, P, W, snapshot({ established: [HOST_PAIR, SDK_PAIR] }), {
      'node:npm-cache': '/data/npm',
    });

    const memory = readWorkshopMemory(memento, P, W);
    assert.deepStrictEqual(memory['node:npm-cache'], {
      host: { slot: slot('system', 'mount'), source: '/data/npm' },
    });
    assert.deepStrictEqual(memory['jupyter:venv'], {
      sdk: { slot: slot('uv', 'venv'), source: '/home/workshop/uv-venv' },
    });
  });

  test('dual wiring: host and SDK channels of one plug stay independent', async () => {
    const dualHost: ConnectionEntry = { plug: plug('jupyter', 'venv'), slot: slot('system', 'mount') };
    await rememberLivePairings(
      memento,
      P,
      W,
      snapshot({ established: [dualHost, SDK_PAIR] }),
      { 'jupyter:venv': '/auto/jupyter/venv' },
    );

    const wiring = readWorkshopMemory(memento, P, W)['jupyter:venv'];
    assert.deepStrictEqual(wiring.host, { slot: slot('system', 'mount'), source: '/auto/jupyter/venv' });
    assert.deepStrictEqual(wiring.sdk, { slot: slot('uv', 'venv'), source: '/home/workshop/uv-venv' });

    // The SDK pairing is later disconnected and dropped by the daemon; the
    // host channel keeps its identity and the sdk channel stays remembered.
    await rememberLivePairings(memento, P, W, snapshot({ established: [dualHost] }), {
      'jupyter:venv': '/auto/jupyter/venv',
    });
    const after = readWorkshopMemory(memento, P, W)['jupyter:venv'];
    assert.deepStrictEqual(after.sdk, { slot: slot('uv', 'venv'), source: '/home/workshop/uv-venv' });
    assert.deepStrictEqual(after.host, { slot: slot('system', 'mount'), source: '/auto/jupyter/venv' });
  });

  test('captured host source survives a disconnect (no path blanking)', async () => {
    // While established, the detail reports the host path.
    await rememberLivePairings(memento, P, W, snapshot({ established: [HOST_PAIR] }), {
      'node:npm-cache': '/auto/node/npm-cache',
    });
    // After a disconnect the daemon reports the pairing as undesired and the
    // detail no longer lists the mount — no hostSources entry.
    await rememberLivePairings(memento, P, W, snapshot({ undesired: [HOST_PAIR] }), {});

    assert.strictEqual(
      readWorkshopMemory(memento, P, W)['node:npm-cache'].host?.source,
      '/auto/node/npm-cache',
    );
  });

  test('undesired pairings are remembered as identity too', async () => {
    await rememberLivePairings(memento, P, W, snapshot({ undesired: [SDK_PAIR] }));
    assert.deepStrictEqual(readWorkshopMemory(memento, P, W)['jupyter:venv'].sdk?.slot, slot('uv', 'venv'));
  });

  test('writes only when the folded memory changed', async () => {
    await rememberLivePairings(memento, P, W, snapshot({ established: [HOST_PAIR] }));
    const updatesAfterFirst = memento.updates;
    await rememberLivePairings(memento, P, W, snapshot({ established: [HOST_PAIR] }));
    assert.strictEqual(memento.updates, updatesAfterFirst, 'an unchanged poll writes nothing');
  });

  test('keys are per workshop and per project', async () => {
    await rememberLivePairings(memento, P, W, snapshot({ established: [HOST_PAIR] }));
    await rememberLivePairings(memento, P, 'other', snapshot({ established: [SDK_PAIR] }));
    await rememberLivePairings(memento, 'p2', W, snapshot({ established: [SDK_PAIR] }));

    assert.deepStrictEqual(new Set(memento.keys()), new Set([
      'workshop.mountWirings/p1/dev',
      'workshop.mountWirings/p1/other',
      'workshop.mountWirings/p2/dev',
    ]));
    assert.ok(readWorkshopMemory(memento, P, W)['node:npm-cache']);
    assert.ok(!readWorkshopMemory(memento, P, W)['jupyter:venv']);
  });

  test('rememberPairing records a single channel', async () => {
    await rememberPairing(memento, P, W, 'go:mod-cache', 'sdk', {
      slot: slot('go', 'cache-slot'),
    });
    assert.deepStrictEqual(readWorkshopMemory(memento, P, W)['go:mod-cache'], {
      sdk: { slot: slot('go', 'cache-slot') },
    });
  });

  test('clearWorkshopMemory deletes the key outright', async () => {
    await rememberLivePairings(memento, P, W, snapshot({ established: [HOST_PAIR] }));
    await clearWorkshopMemory(memento, P, W);
    assert.ok(!memento.keys().includes(memoryKey(P, W)), 'key removed, not emptied');
    assert.deepStrictEqual(readWorkshopMemory(memento, P, W), {});
  });

  test('pruneMemory keeps built workshops and other projects, drops the rest', async () => {
    await rememberLivePairings(memento, P, 'stopped-one', snapshot({ established: [HOST_PAIR] }));
    await rememberLivePairings(memento, P, 'removed-one', snapshot({ established: [HOST_PAIR] }));
    await rememberLivePairings(memento, 'p2', W, snapshot({ established: [HOST_PAIR] }));

    // A stopped workshop is still built - its memory must survive pruning.
    await pruneMemory(memento, P, ['stopped-one']);

    assert.deepStrictEqual(new Set(memento.keys()), new Set([
      memoryKey(P, 'stopped-one'),
      memoryKey('p2', W),
    ]));
  });
});

suite('isBuilt', () => {
  const base = { name: 'dev', projectId: 'p1' } as const;

  test('container existence follows the raw status, not the display status', () => {
    assert.ok(isBuilt({ ...base, status: 'On', rawStatus: 'ready' }));
    assert.ok(isBuilt({ ...base, status: 'Off', rawStatus: 'stopped' }), 'stopped is still built');
    assert.ok(isBuilt({ ...base, status: 'Pending', rawStatus: 'pending' }));
    assert.ok(!isBuilt({ ...base, status: 'Off', rawStatus: 'off' }));
    assert.ok(!isBuilt({ ...base, status: 'Off' }), 'definition-only is not built');
  });
});
