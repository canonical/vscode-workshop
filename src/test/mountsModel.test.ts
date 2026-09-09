import * as assert from 'assert';

import { ConnectionsSnapshot } from '../api/connections';
import {
  buildSections,
  fallbackTarget,
  rowId,
  sdkSlotCandidates,
  shortenHostPath,
} from '../interfaces/model';

const P = 'p1';
const W = 'dev';

function plugRef(sdk: string, name: string) {
  return { 'project-id': P, workshop: W, sdk, plug: name };
}

function slotRef(sdk: string, name: string) {
  return { 'project-id': P, workshop: W, sdk, slot: name };
}

const HOST_SLOT = slotRef('system', 'mount');

function snapshot(parts: Partial<ConnectionsSnapshot>): ConnectionsSnapshot {
  return { established: [], undesired: [], plugs: [], slots: [], ...parts };
}

function build(overrides: {
  snapshot: ConnectionsSnapshot;
  mounts?: Record<string, { hostSource: string; workshopTarget?: string }>;
}) {
  return buildSections({
    projectId: P,
    workshop: W,
    snapshot: overrides.snapshot,
    mounts: overrides.mounts ?? {},
  });
}

suite('buildSections', () => {
  test('a connected host mount renders in Host to Workshop with path, target and menu', () => {
    const sections = build({
      snapshot: snapshot({
        established: [{
          plug: plugRef('node', 'npm-cache'),
          slot: HOST_SLOT,
          'plug-attrs': { 'workshop-target': '/home/workshop/.npm/_cacache' },
        }],
        plugs: [{ ...plugRef('node', 'npm-cache'), attrs: { 'workshop-target': '/home/workshop/.npm/_cacache' } }],
        slots: [{ ...HOST_SLOT }],
      }),
      mounts: { 'node:npm-cache': { hostSource: '/data/id/86e64b3e/dev/mount/node/npm-cache' } },
    });

    assert.strictEqual(sections.length, 1);
    const [host] = sections;
    assert.strictEqual(host.title, 'Host to Workshop');
    assert.strictEqual(host.sourceHeader, 'Host Source');
    const row = host.rows[0];
    assert.strictEqual(row.connected, true);
    assert.strictEqual(row.source, '/data/id/86e64b3e/dev/mount/node/npm-cache');
    assert.strictEqual(row.sourceDisplay, '…/86e64b3e/dev/mount/node/npm-cache');
    assert.strictEqual(row.sourceSub, 'system:mount');
    assert.strictEqual(row.target, '/home/workshop/.npm/_cacache');
    assert.strictEqual(row.targetSub, 'node:npm-cache');
    assert.deepStrictEqual(row.menu, ['remount'], 'no SDK slots → remount only');
  });

  test('an internal SDK↔SDK mount renders in Workshop, listed first, with no menu', () => {
    const sections = build({
      snapshot: snapshot({
        established: [
          { plug: plugRef('node', 'npm-cache'), slot: HOST_SLOT },
          {
            plug: plugRef('jupyter', 'venv'),
            slot: slotRef('uv', 'venv'),
            'slot-attrs': { 'workshop-source': '/home/workshop/uv-venv' },
          },
        ],
        plugs: [
          { ...plugRef('jupyter', 'venv'), attrs: { 'workshop-target': '/var/lib/venv' } },
          { ...plugRef('node', 'npm-cache') },
        ],
        slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }],
      }),
    });

    assert.deepStrictEqual(sections.map((s) => s.title), ['Workshop', 'Host to Workshop']);
    const internal = sections[0].rows[0];
    assert.strictEqual(internal.connected, true);
    assert.strictEqual(internal.source, '/home/workshop/uv-venv');
    assert.strictEqual(internal.sourceSub, 'uv:venv');
    assert.strictEqual(internal.target, '/var/lib/venv');
    assert.deepStrictEqual(internal.menu, [], 'internal mounts are never remountable');
  });

  test('a plug with no live or disconnected pairing is a disconnected host row', () => {
    const sections = build({
      snapshot: snapshot({
        plugs: [{ ...plugRef('uv', 'cache'), attrs: { 'workshop-target': '/home/workshop/.cache/uv' } }],
        slots: [{ ...HOST_SLOT }],
      }),
    });

    assert.strictEqual(sections.length, 1);
    const row = sections[0].rows[0];
    assert.strictEqual(sections[0].id, 'host');
    assert.strictEqual(row.connected, false);
    assert.strictEqual(row.source, undefined, 'unknown source renders as em-dash');
    assert.deepStrictEqual(row.slot, HOST_SLOT, 'its toggle connects to the host');
    assert.deepStrictEqual(row.menu, []);
  });

  test('an undesired pairing is a disconnected internal row that keeps identity, section and source', () => {
    const sections = build({
      snapshot: snapshot({
        undesired: [{
          plug: plugRef('jupyter', 'venv'),
          slot: slotRef('uv', 'venv'),
          'slot-attrs': { 'workshop-source': '/home/workshop/uv-venv' },
        }],
        plugs: [{ ...plugRef('jupyter', 'venv') }],
        slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }],
      }),
    });

    const row = sections[0].rows[0];
    assert.strictEqual(sections[0].id, 'workshop', 'disconnected SDK pairing stays internal');
    assert.strictEqual(row.connected, false);
    assert.deepStrictEqual(row.slot, slotRef('uv', 'venv'));
    assert.strictEqual(row.source, '/home/workshop/uv-venv', 'source from undesired slot-attrs');
    assert.deepStrictEqual(row.menu, ['connect-to-sdk'], 'SDK slots exist');
  });

  test('dual wiring: host + SDK wirings of one plug are two independent rows (AC 13)', () => {
    const sections = build({
      snapshot: snapshot({
        established: [{ plug: plugRef('jupyter', 'venv'), slot: slotRef('uv', 'venv') }],
        undesired: [{
          plug: plugRef('jupyter', 'venv'),
          slot: HOST_SLOT,
          'slot-attrs': { 'host-source': '/data/id/86e64b3e/dev/mount/jupyter/venv' },
        }],
        plugs: [{ ...plugRef('jupyter', 'venv') }],
        slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }],
      }),
    });

    assert.strictEqual(sections.length, 2, 'one row per wiring, each in its own section');
    const internal = sections[0].rows[0];
    const host = sections[1].rows[0];
    assert.strictEqual(internal.connected, true);
    assert.strictEqual(host.connected, false);
    assert.strictEqual(
      host.source,
      '/data/id/86e64b3e/dev/mount/jupyter/venv',
      'disconnected host row keeps its path from the undesired slot-attrs',
    );
    assert.notStrictEqual(internal.id, host.id);
  });

  test('rows sort by SDK then plug name within a section', () => {
    const sections = build({
      snapshot: snapshot({
        established: [
          { plug: plugRef('uv', 'cache'), slot: HOST_SLOT },
          { plug: plugRef('go', 'mod-cache'), slot: HOST_SLOT },
          { plug: plugRef('node', 'yarn-cache'), slot: HOST_SLOT },
          { plug: plugRef('node', 'npm-cache'), slot: HOST_SLOT },
        ],
        plugs: [
          { ...plugRef('uv', 'cache') },
          { ...plugRef('go', 'mod-cache') },
          { ...plugRef('node', 'yarn-cache') },
          { ...plugRef('node', 'npm-cache') },
        ],
        slots: [{ ...HOST_SLOT }],
      }),
    });

    assert.deepStrictEqual(
      sections[0].rows.map((r) => r.targetSub),
      ['go:mod-cache', 'node:npm-cache', 'node:yarn-cache', 'uv:cache'],
    );
  });

  test('no sections at all when there are no plugs', () => {
    assert.deepStrictEqual(build({ snapshot: snapshot({}) }), []);
  });

  test('connect-to-sdk appears on a connected host row only when SDK slots exist', () => {
    const base = {
      established: [{ plug: plugRef('node', 'npm-cache'), slot: HOST_SLOT }],
      plugs: [{ ...plugRef('node', 'npm-cache') }],
    };
    const withSdk = build({
      snapshot: snapshot({ ...base, slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }] }),
    });
    const withoutSdk = build({
      snapshot: snapshot({ ...base, slots: [{ ...HOST_SLOT }] }),
    });

    assert.deepStrictEqual(withSdk[0].rows[0].menu, ['remount', 'connect-to-sdk']);
    assert.deepStrictEqual(withoutSdk[0].rows[0].menu, ['remount']);
  });
});

suite('sdkSlotCandidates / fallbackTarget', () => {
  test('candidates are the non-system mount slots, sorted', () => {
    const candidates = sdkSlotCandidates(snapshot({
      slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }, { ...slotRef('go', 'share') }],
    }));
    assert.deepStrictEqual(candidates.map((s) => `${s.sdk}:${s.slot}`), ['go:share', 'uv:venv']);
  });

  test('fallback offers the host when the failed pairing is not the host', () => {
    assert.deepStrictEqual(
      fallbackTarget(slotRef('uv', 'venv'), plugRef('jupyter', 'venv')),
      HOST_SLOT,
    );
  });

  test('no modal target when the host pairing itself failed', () => {
    assert.strictEqual(
      fallbackTarget(HOST_SLOT, plugRef('node', 'npm-cache')),
      undefined,
    );
  });
});

suite('shortenHostPath', () => {
  test('shortens only under an id/<8-hex> data-dir segment', () => {
    assert.strictEqual(
      shortenHostPath('/home/u/.local/share/workshop/id/86e64b3e/dev2/mount/node/npm-cache'),
      '…/86e64b3e/dev2/mount/node/npm-cache',
    );
  });

  test('never mangles a user path that merely contains eight hex digits', () => {
    assert.strictEqual(shortenHostPath('/backups/86e64b3e/data'), undefined);
    assert.strictEqual(shortenHostPath('/home/user/projects/data'), undefined);
    assert.strictEqual(shortenHostPath('/id-cards/86e64b3e/x'), undefined, 'segment must be exactly "id"');
    assert.strictEqual(shortenHostPath('/data/id/86e64b3/x'), undefined, '7 hex digits is not a project id');
  });
});
