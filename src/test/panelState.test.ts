import * as assert from 'assert';

import { MountSection } from '../interfaces/model';
import {
  derivePanelState,
  MSG_DEVICES,
  MSG_LOADING,
  MSG_NO_MOUNTS,
  MSG_NO_WORKSHOPS,
  MSG_OFF,
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

  test('a Pending workshop with a snapshot renders the table (never a task message)', () => {
    assert.deepStrictEqual(
      derivePanelState({ status: 'Pending', sections: SECTIONS }),
      { kind: 'table', sections: SECTIONS },
    );
  });

  test('a Pending workshop with no snapshot yet → Loading', () => {
    assert.deepStrictEqual(
      derivePanelState({ status: 'Pending' }),
      message(MSG_LOADING),
    );
  });

  test('Off / Error / Unknown → the Off message with no rows', () => {
    for (const status of ['Off', 'Error', 'Unknown'] as const) {
      assert.deepStrictEqual(
        derivePanelState({ status, sections: SECTIONS }),
        message(MSG_OFF),
      );
    }
    assert.strictEqual(MSG_OFF, 'Workshop is Off. Launch this workshop to see existing mounts.');
  });

  test('launched with no snapshot yet → Loading; with no plugs → No mounts', () => {
    assert.deepStrictEqual(
      derivePanelState({ status: 'On' }),
      message(MSG_LOADING),
    );
    assert.deepStrictEqual(
      derivePanelState({ status: 'On', sections: [] }),
      message(MSG_NO_MOUNTS),
    );
  });

  test('launched with rows → the table (On and Waiting)', () => {
    for (const status of ['On', 'Waiting'] as const) {
      assert.deepStrictEqual(
        derivePanelState({ status, sections: SECTIONS }),
        { kind: 'table', sections: SECTIONS },
      );
    }
  });

  test('verbatim message strings', () => {
    assert.strictEqual(MSG_LOADING, 'Loading mounts…');
    assert.strictEqual(MSG_NO_MOUNTS, 'No mounts');
    assert.strictEqual(MSG_NO_WORKSHOPS, 'No workshops in this project.');
    assert.strictEqual(MSG_DEVICES, 'Devices are coming soon.');
  });
});
