import * as assert from 'assert';

import { WorkshopApiError } from '../api/client';
import { ConnectionsSnapshot, PlugRef, SlotRef } from '../api/connections';
import { createMountsActions, MountsActionsDeps, MountsUi } from '../interfaces/actions';
import { MountRow } from '../interfaces/model';
import { WorkshopOperationQueue } from '../interfaces/queue';

const P = 'p1';
const W = 'dev';

function plugRef(sdk: string, name: string): PlugRef {
  return { 'project-id': P, workshop: W, sdk, plug: name };
}

function slotRef(sdk: string, name: string): SlotRef {
  return { 'project-id': P, workshop: W, sdk, slot: name };
}

const HOST_SLOT = slotRef('system', 'mount');

function hostRow(overrides?: Partial<MountRow>): MountRow {
  return {
    id: 'host|node:npm-cache|system:mount',
    section: 'host',
    plug: plugRef('node', 'npm-cache'),
    slot: HOST_SLOT,
    connected: true,
    source: '/data/id/12345678/dev/mount/node/npm-cache',
    sourceSub: 'system:mount',
    targetSub: 'node:npm-cache',
    menu: ['remount'],
    ...overrides,
  };
}

interface UiScript {
  confirm?: boolean;
  folder?: string;
  slotPick?: string;
}

function makeUi(script: UiScript): MountsUi & {
  errors: string[];
  modals: { message: string; detail: string; confirm: string }[];
  progressTitles: string[];
  folderRequests: { title: string; openLabel: string }[];
  slotPicks: { title: string; items: string[] }[];
} {
  return {
    errors: [],
    modals: [],
    progressTitles: [],
    folderRequests: [],
    slotPicks: [],
    showError(message) {
      this.errors.push(message);
    },
    async withProgress(title, task) {
      this.progressTitles.push(title);
      return task();
    },
    async pickFolder(options) {
      this.folderRequests.push(options);
      return script.folder;
    },
    async confirmModal(message, detail, confirm) {
      this.modals.push({ message, detail, confirm });
      return script.confirm ?? false;
    },
    async pickSlot(title, items) {
      this.slotPicks.push({ title, items });
      return script.slotPick;
    },
  };
}

interface ClientScript {
  connectResults?: (Error | undefined)[];
  remountResults?: (Error | undefined)[];
  snapshot?: ConnectionsSnapshot;
}

function makeClient(script: ClientScript) {
  const calls: string[] = [];
  let connectIndex = 0;
  let remountIndex = 0;
  let active = 0;
  let maxActive = 0;
  const track = async <T>(name: string, result: T | Error | undefined): Promise<T> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(name);
    await new Promise<void>((r) => setTimeout(r, 2));
    active -= 1;
    if (result instanceof Error) {
      throw result;
    }
    return result as T;
  };
  const done = { id: 'c', kind: 'x', status: 'Done', ready: true };
  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    connectionsAction(action: string, plug: PlugRef, slot: SlotRef) {
      const error = script.connectResults?.[connectIndex];
      connectIndex += 1;
      return track(`${action}:${plug.sdk}:${plug.plug}->${slot.sdk}:${slot.slot}`, error ?? done);
    },
    remountPlug(_projectId: string, _workshop: string, plug: PlugRef, hostSource: string) {
      const error = script.remountResults?.[remountIndex];
      remountIndex += 1;
      return track(`remount:${plug.sdk}:${plug.plug}->${hostSource}`, error ?? done);
    },
    async getConnections() {
      calls.push('getConnections');
      return script.snapshot ?? { established: [], undesired: [], plugs: [], slots: [] };
    },
  };
}

function makeActions(clientScript: ClientScript, uiScript: UiScript) {
  const client = makeClient(clientScript);
  const ui = makeUi(uiScript);
  const deps: MountsActionsDeps = {
    client,
    ui,
    queue: new WorkshopOperationQueue(),
    log: { info: () => {}, error: () => {} },
  };
  return { actions: createMountsActions(deps), client, ui };
}

suite('mounts actions — toggle', () => {
  test('disconnect sends exactly the row pairing, no progress', async () => {
    const { actions, client, ui } = makeActions({}, {});
    await actions.toggle(hostRow(), false);

    assert.deepStrictEqual(client.calls, ['disconnect:node:npm-cache->system:mount']);
    assert.deepStrictEqual(ui.progressTitles, []);
  });

  test('connect sends exactly the row pairing, no progress', async () => {
    const { actions, client, ui } = makeActions({}, {});
    await actions.toggle(hostRow({ connected: false }), true);

    assert.deepStrictEqual(client.calls, ['connect:node:npm-cache->system:mount']);
    assert.deepStrictEqual(ui.progressTitles, []);
  });

  test('a failed disconnect shows the exact toast and rethrows', async () => {
    const { actions, ui } = makeActions(
      { connectResults: [new WorkshopApiError('mount is busy', 400)] },
      {},
    );
    await assert.rejects(() => actions.toggle(hostRow(), false), /mount is busy/);
    assert.deepStrictEqual(ui.errors, ['Disconnect failed: mount is busy']);
  });

  test('change-conflict takes the plain failure path - no modal, no retry', async () => {
    const { actions, ui, client } = makeActions(
      {
        connectResults: [
          new WorkshopApiError('workshop "dev" has "refresh" change in progress', 400),
        ],
      },
      { confirm: true },
    );
    await assert.rejects(() => actions.toggle(hostRow({ connected: false }), true));

    assert.deepStrictEqual(ui.modals, []);
    assert.deepStrictEqual(ui.errors, [
      'Connect failed: workshop "dev" has "refresh" change in progress',
    ]);
    assert.strictEqual(
      client.calls.filter((c) => c.startsWith('connect:')).length,
      1,
      'nothing is retried automatically',
    );
  });

  test('a refused workshop pairing offers the host fallback and Connect wires it', async () => {
    const row: MountRow = {
      ...hostRow(),
      id: 'workshop|jupyter:venv|uv:venv',
      section: 'workshop',
      plug: plugRef('jupyter', 'venv'),
      slot: slotRef('uv', 'venv'),
      connected: false,
      menu: [],
    };
    const { actions, ui, client } = makeActions(
      { connectResults: [new WorkshopApiError('slot gone', 400), undefined] },
      { confirm: true },
    );

    await assert.rejects(() => actions.toggle(row, true), /slot gone/);

    assert.strictEqual(ui.modals.length, 1);
    assert.strictEqual(
      ui.modals[0].message,
      "Can't establish the connection. Would you like to connect jupyter:venv to system:mount instead?",
    );
    assert.strictEqual(ui.modals[0].detail, 'slot gone', "the daemon's reason is the detail");
    assert.ok(client.calls.includes('connect:jupyter:venv->system:mount'), 'the offered target is wired');
  });

  test('no different fallback target → no modal, plain failure', async () => {
    // The host pairing itself was refused and nothing else exists to offer.
    const { actions, ui } = makeActions(
      { connectResults: [new WorkshopApiError('refused', 400)] },
      { confirm: true },
    );
    await assert.rejects(() => actions.toggle(hostRow({ connected: false }), true), /refused/);

    assert.deepStrictEqual(ui.modals, []);
    assert.deepStrictEqual(ui.errors, ['Connect failed: refused']);
  });

  test('declining the fallback modal changes nothing further', async () => {
    const { actions, ui, client } = makeActions(
      { connectResults: [new WorkshopApiError('slot gone', 400)] },
      { confirm: false },
    );
    const row = hostRow({
      id: 'workshop|jupyter:venv|uv:venv',
      section: 'workshop',
      plug: plugRef('jupyter', 'venv'),
      slot: slotRef('uv', 'venv'),
      connected: false,
    });
    await assert.rejects(() => actions.toggle(row, true), /slot gone/);

    assert.strictEqual(ui.modals.length, 1);
    assert.strictEqual(client.calls.filter((c) => c.startsWith('connect:')).length, 1);
    assert.deepStrictEqual(ui.errors, [], 'the modal replaces the toast');
  });
});

suite('mounts actions — remount', () => {
  test('cancelling the folder picker changes nothing', async () => {
    const { actions, client, ui } = makeActions({}, { folder: undefined });
    await actions.menu(hostRow(), 'remount');

    assert.deepStrictEqual(ui.folderRequests, [{ title: 'Remount node:npm-cache', openLabel: 'Remount here' }]);
    assert.ok(!client.calls.some((c) => c.startsWith('remount:')));
  });

  test('a chosen folder remounts under progress', async () => {
    const { actions, client, ui } = makeActions({}, { folder: '/backups/data' });
    await actions.menu(hostRow(), 'remount');

    assert.deepStrictEqual(ui.progressTitles, ['Remounting node:npm-cache']);
    assert.ok(client.calls.includes('remount:node:npm-cache->/backups/data'));
    assert.deepStrictEqual(ui.modals, [], 'no confirmation modal');
  });

  test('a failed remount shows the operation-named toast', async () => {
    const { actions, client, ui } = makeActions(
      { remountResults: [new WorkshopApiError('cross-device', 400)] },
      { folder: '/backups/data' },
    );
    await assert.rejects(() => actions.menu(hostRow(), 'remount'), /cross-device/);

    assert.ok(client.calls.includes('remount:node:npm-cache->/backups/data'));
    assert.deepStrictEqual(ui.errors, ['Remount failed: cross-device']);
  });
});

suite('mounts actions — connect to SDK', () => {
  const row = hostRow({ menu: ['remount', 'connect-to-sdk'] });

  function withSlots(slots: SlotRef[]): ConnectionsSnapshot {
    return {
      established: [],
      undesired: [],
      plugs: [{ ...plugRef('node', 'npm-cache'), interface: 'mount' }],
      slots: slots.map((slot) => ({ ...slot, interface: 'mount' })),
    };
  }

  test('one candidate connects without asking', async () => {
    const { actions, client, ui } = makeActions(
      { snapshot: withSlots([HOST_SLOT, slotRef('uv', 'venv')]) },
      {},
    );
    await actions.menu(row, 'connect-to-sdk');

    assert.deepStrictEqual(ui.slotPicks, []);
    assert.ok(client.calls.includes('connect:node:npm-cache->uv:venv'));
    assert.deepStrictEqual(ui.progressTitles, ['Connecting node:npm-cache to uv:venv']);
  });

  test('several candidates go through the QuickPick; cancel changes nothing', async () => {
    const snapshot = withSlots([HOST_SLOT, slotRef('uv', 'venv'), slotRef('go', 'share')]);
    const cancelled = makeActions({ snapshot }, { slotPick: undefined });
    await cancelled.actions.menu(row, 'connect-to-sdk');
    assert.deepStrictEqual(cancelled.ui.slotPicks, [{
      title: 'Connect node:npm-cache to…',
      items: ['go:share', 'uv:venv'],
    }]);
    assert.ok(!cancelled.client.calls.some((c) => c.startsWith('connect:')));

    const picked = makeActions({ snapshot }, { slotPick: 'go:share' });
    await picked.actions.menu(row, 'connect-to-sdk');
    assert.ok(picked.client.calls.includes('connect:node:npm-cache->go:share'));
  });

  test('failure shows the operation-named toast', async () => {
    const { actions, ui } = makeActions(
      {
        snapshot: withSlots([slotRef('uv', 'venv')]),
        connectResults: [new WorkshopApiError('refused', 400)],
      },
      {},
    );
    await assert.rejects(() => actions.menu(row, 'connect-to-sdk'), /refused/);
    assert.deepStrictEqual(ui.errors, ['Connect to SDK failed: refused']);
  });
});

suite('mounts actions — per-workshop serialization', () => {
  test('several toggles at once never overlap at the daemon', async () => {
    const { actions, client } = makeActions({}, {});
    await Promise.all([
      actions.toggle(hostRow(), false),
      actions.toggle(hostRow({ id: 'host|uv:cache|system:mount', plug: plugRef('uv', 'cache') }), false),
      actions.toggle(hostRow({ id: 'host|go:mod-cache|system:mount', plug: plugRef('go', 'mod-cache') }), false),
    ]);

    assert.strictEqual(client.maxActive, 1, 'one change in flight at a time');
    assert.strictEqual(client.calls.filter((c) => c.startsWith('disconnect:')).length, 3);
  });
});
