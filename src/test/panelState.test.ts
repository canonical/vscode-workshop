import * as assert from 'assert';

import { MountSection } from '../interfaces/model';
import {
  derivePanelState,
  MSG_DEVICES,
  MSG_LOADING,
  MSG_NO_MOUNTS,
  MSG_NO_WORKSHOPS,
  MSG_OFF,
  pendingMessage,
  workshopGoneMessage,
} from '../interfaces/panelState';

function message(text: string) {
  return { kind: 'message', text };
}

const SECTIONS: MountSection[] = [{
  id: 'host',
  title: 'Host to Workshop',
  sourceHeader: 'Host Source',
  rows: [],
}];

suite('derivePanelState message matrix', () => {
  test('no data yet → Loading mounts…', () => {
    assert.deepStrictEqual(derivePanelState({}), message(MSG_LOADING));
  });

  test('no workshops → No workshops in this project.', () => {
    assert.deepStrictEqual(derivePanelState({ workshops: [] }), message(MSG_NO_WORKSHOPS));
  });

  test('selected workshop vanished → Workshop <name> no longer exists.', () => {
    assert.deepStrictEqual(
      derivePanelState({ workshops: ['db', 'web'], selected: 'gone' }),
      message(workshopGoneMessage('gone')),
    );
    assert.strictEqual(workshopGoneMessage('gone'), 'Workshop gone no longer exists.');
  });

  test('matched lifecycle Pending → task message with the change kind', () => {
    for (const kind of ['launch', 'refresh']) {
      assert.deepStrictEqual(
        derivePanelState({
          workshops: ['dev'],
          selected: 'dev',
          status: 'Pending',
          pendingKind: kind,
          sections: SECTIONS,
        }),
        message(pendingMessage(kind)),
      );
    }
    assert.strictEqual(
      pendingMessage('launch'),
      'Launch task in progress… Mounts will show when workshop is ready',
    );
  });

  test('Pending with a row-level change keeps the table live (no pendingKind set)', () => {
    // The data layer never sets pendingKind for connect/disconnect/remount;
    // given that, a Pending workshop with a snapshot renders the table.
    assert.deepStrictEqual(
      derivePanelState({ workshops: ['dev'], selected: 'dev', status: 'Pending', sections: SECTIONS }),
      { kind: 'table', sections: SECTIONS },
    );
  });

  test('unmatched Pending with no snapshot yet → Loading, never a fabricated task name', () => {
    assert.deepStrictEqual(
      derivePanelState({ workshops: ['dev'], selected: 'dev', status: 'Pending' }),
      message(MSG_LOADING),
    );
  });

  test('Off / Error / Unknown → the Off message with no rows', () => {
    for (const status of ['Off', 'Error', 'Unknown'] as const) {
      assert.deepStrictEqual(
        derivePanelState({ workshops: ['dev'], selected: 'dev', status, sections: SECTIONS }),
        message(MSG_OFF),
      );
    }
    assert.strictEqual(MSG_OFF, 'Workshop is Off. Launch this workshop to see existing mounts.');
  });

  test('launched with no snapshot yet → Loading; with no plugs → No mounts', () => {
    assert.deepStrictEqual(
      derivePanelState({ workshops: ['dev'], selected: 'dev', status: 'On' }),
      message(MSG_LOADING),
    );
    assert.deepStrictEqual(
      derivePanelState({ workshops: ['dev'], selected: 'dev', status: 'On', sections: [] }),
      message(MSG_NO_MOUNTS),
    );
  });

  test('launched with rows → the table (On and Waiting)', () => {
    for (const status of ['On', 'Waiting'] as const) {
      assert.deepStrictEqual(
        derivePanelState({ workshops: ['dev'], selected: 'dev', status, sections: SECTIONS }),
        { kind: 'table', sections: SECTIONS },
      );
    }
  });

  test('verbatim message strings', () => {
    assert.strictEqual(MSG_LOADING, 'Loading mounts…');
    assert.strictEqual(MSG_NO_MOUNTS, 'No mounts');
    assert.strictEqual(MSG_NO_WORKSHOPS, 'No workshops in this project.');
    assert.strictEqual(MSG_DEVICES, 'Devices are coming soon.');
    assert.strictEqual(
      pendingMessage('remount'),
      'Remount task in progress… Mounts will show when workshop is ready',
    );
  });
});
