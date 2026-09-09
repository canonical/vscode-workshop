import * as assert from 'assert';

import { ConnectionsSnapshot } from '../api/connections';
import {
  buildSections,
  fallbackTarget,
  rowId,
  sdkSlotCandidates,
  shortenHostPath,
} from '../mounts/model';
import { WorkshopMemory } from '../mounts/memory';
import { DeclaredPairing } from '../mounts/declared';

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

function declared(plug: string, slot: string): DeclaredPairing {
  const [psdk, pname] = plug.split(':');
  const [ssdk, sname] = slot.split(':');
  return { plug: { sdk: psdk, name: pname }, slot: { sdk: ssdk, name: sname } };
}

function build(overrides: {
  snapshot: ConnectionsSnapshot;
  mounts?: Record<string, { hostSource: string; workshopTarget?: string }>;
  declared?: DeclaredPairing[];
  memory?: WorkshopMemory;
  pendingRowIds?: Set<string>;
}) {
  return buildSections({
    projectId: P,
    workshop: W,
    snapshot: overrides.snapshot,
    mounts: overrides.mounts ?? {},
    declared: overrides.declared ?? [],
    memory: overrides.memory ?? {},
    pendingRowIds: overrides.pendingRowIds ?? new Set(),
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

  test('a plug with no live, remembered or declared pairing is a disconnected host row', () => {
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

  test('disconnected identity precedence: remembered wins over declared', () => {
    const memory: WorkshopMemory = {
      'jupyter:venv': { sdk: { slot: slotRef('uv', 'venv'), source: '/home/workshop/uv-venv' } },
    };
    const sections = build({
      snapshot: snapshot({
        plugs: [{ ...plugRef('jupyter', 'venv') }],
        slots: [{ ...HOST_SLOT }, { ...slotRef('go', 'share') }, { ...slotRef('uv', 'venv') }],
      }),
      declared: [declared('jupyter:venv', 'go:share')],
      memory,
    });

    const row = sections[0].rows[0];
    assert.strictEqual(sections[0].id, 'workshop', 'remembered SDK pairing keeps it internal');
    assert.deepStrictEqual(row.slot, slotRef('uv', 'venv'));
    assert.strictEqual(row.source, '/home/workshop/uv-venv', 'source kept from memory');
    assert.strictEqual(row.connected, false);
    assert.deepStrictEqual(row.menu, ['connect-to-sdk'], 'SDK slots exist');
  });

  test('declared fallback applies when nothing is remembered (post Turn Off → Launch)', () => {
    const sections = build({
      snapshot: snapshot({
        plugs: [{ ...plugRef('jupyter', 'venv') }],
        slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv'), attrs: { 'workshop-source': '/home/workshop/uv-venv' } }],
      }),
      declared: [declared('jupyter:venv', 'uv:venv')],
    });

    const row = sections[0].rows[0];
    assert.deepStrictEqual(row.slot, slotRef('uv', 'venv'));
    assert.strictEqual(row.source, '/home/workshop/uv-venv', 'source from the live slot attrs');
  });

  test('an undesired pairing is a disconnected row that keeps its identity and section', () => {
    const sections = build({
      snapshot: snapshot({
        undesired: [{ plug: plugRef('jupyter', 'venv'), slot: slotRef('uv', 'venv') }],
        plugs: [{ ...plugRef('jupyter', 'venv') }],
        slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }],
      }),
    });

    assert.strictEqual(sections[0].id, 'workshop');
    assert.strictEqual(sections[0].rows[0].connected, false);
    assert.deepStrictEqual(sections[0].rows[0].slot, slotRef('uv', 'venv'));
  });

  test('dual wiring: host + SDK wirings of one plug are two independent rows (AC 13)', () => {
    const memory: WorkshopMemory = {
      'jupyter:venv': {
        host: { slot: HOST_SLOT, source: '/data/id/86e64b3e/dev/mount/jupyter/venv' },
      },
    };
    const sections = build({
      snapshot: snapshot({
        established: [{ plug: plugRef('jupyter', 'venv'), slot: slotRef('uv', 'venv') }],
        plugs: [{ ...plugRef('jupyter', 'venv') }],
        slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }],
      }),
      memory,
    });

    assert.strictEqual(sections.length, 2, 'one row per wiring, each in its own section');
    const internal = sections[0].rows[0];
    const host = sections[1].rows[0];
    assert.strictEqual(internal.connected, true);
    assert.strictEqual(host.connected, false);
    assert.strictEqual(
      host.source,
      '/data/id/86e64b3e/dev/mount/jupyter/venv',
      'disconnected host row keeps its remembered path',
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

  test('pending rows carry pending=true; no sections at all when no plugs', () => {
    const id = rowId('host', { sdk: 'node', plug: 'npm-cache' }, { sdk: 'system', slot: 'mount' });
    const sections = build({
      snapshot: snapshot({
        established: [{ plug: plugRef('node', 'npm-cache'), slot: HOST_SLOT }],
        plugs: [{ ...plugRef('node', 'npm-cache') }],
        slots: [{ ...HOST_SLOT }],
      }),
      pendingRowIds: new Set([id]),
    });
    assert.strictEqual(sections[0].rows[0].pending, true);

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

  test('fallback offers the declared slot when live and different from the failed one', () => {
    const snap = snapshot({ slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }] });
    const target = fallbackTarget(
      slotRef('go', 'share'), // the pairing that just failed
      plugRef('jupyter', 'venv'),
      [declared('jupyter:venv', 'uv:venv')],
      snap,
    );
    assert.deepStrictEqual(target, slotRef('uv', 'venv'));
  });

  test('fallback degrades to the host when declared is dead, same, or absent', () => {
    const snap = snapshot({ slots: [{ ...HOST_SLOT }] });
    // Declared slot not live → host.
    assert.deepStrictEqual(
      fallbackTarget(slotRef('go', 'share'), plugRef('jupyter', 'venv'), [declared('jupyter:venv', 'uv:venv')], snap),
      HOST_SLOT,
    );
    // Declared slot is the one that failed → host.
    assert.deepStrictEqual(
      fallbackTarget(slotRef('uv', 'venv'), plugRef('jupyter', 'venv'), [declared('jupyter:venv', 'uv:venv')], snapshot({ slots: [{ ...HOST_SLOT }, { ...slotRef('uv', 'venv') }] })),
      HOST_SLOT,
    );
  });

  test('no modal target when the host pairing itself failed and nothing else differs', () => {
    assert.strictEqual(
      fallbackTarget(HOST_SLOT, plugRef('node', 'npm-cache'), [], snapshot({ slots: [{ ...HOST_SLOT }] })),
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
