import * as assert from 'assert';
import * as vscode from 'vscode';

import { mergeWorkshops, normalizeStatus, reopenAction } from '../api/workshops';
import { statusIcon } from '../ui/statusIcon';

suite('workshops model', () => {
  test('normalizeStatus maps known statuses case-insensitively', () => {
    assert.strictEqual(normalizeStatus('ready'), 'On');
    assert.strictEqual(normalizeStatus('READY'), 'On');
    assert.strictEqual(normalizeStatus('stopped'), 'Off');
    assert.strictEqual(normalizeStatus('STOPPED'), 'Off');
    assert.strictEqual(normalizeStatus('off'), 'Off');
    assert.strictEqual(normalizeStatus('Waiting'), 'Waiting');
    assert.strictEqual(normalizeStatus('pending'), 'Pending');
    assert.strictEqual(normalizeStatus('error'), 'Error');
    assert.strictEqual(normalizeStatus('bogus'), 'Unknown');
    assert.strictEqual(normalizeStatus(undefined), 'Unknown');
  });

  test('mergeWorkshops combines live workshops and definition files', () => {
    const merged = mergeWorkshops({
      workshops: [
        { 'project-id': 'p', name: 'beta', status: 'ready', hostname: 'beta.p.wp' },
        { 'project-id': 'p', name: 'alpha', status: 'waiting' },
      ],
      files: [
        // alpha is also live above; the live status must win.
        { 'project-id': 'p', name: 'alpha', path: '/x/alpha.yaml' },
        // gamma only exists on disk -> Off.
        { 'project-id': 'p', name: 'gamma', path: '/x/gamma.yaml' },
      ],
    });

    assert.deepStrictEqual(merged, [
      { name: 'alpha', status: 'Waiting', rawStatus: 'waiting', hostname: undefined },
      { name: 'beta', status: 'On', rawStatus: 'ready', hostname: 'beta.p.wp' },
      { name: 'gamma', status: 'Off' },
    ]);
  });

  test('mergeWorkshops keeps stopped and off distinct in rawStatus', () => {
    const merged = mergeWorkshops({
      workshops: [
        { 'project-id': 'p', name: 'stopped-one', status: 'stopped' },
        { 'project-id': 'p', name: 'off-one', status: 'off' },
      ],
    });

    assert.deepStrictEqual(merged, [
      { name: 'off-one', status: 'Off', rawStatus: 'off', hostname: undefined },
      { name: 'stopped-one', status: 'Off', rawStatus: 'stopped', hostname: undefined },
    ]);
  });

  test('mergeWorkshops tolerates empty response', () => {
    assert.deepStrictEqual(mergeWorkshops({}), []);
  });
});

suite('reopenAction', () => {
  test('running workshops connect directly', () => {
    assert.strictEqual(reopenAction({ name: 'a', status: 'On', rawStatus: 'ready' }), 'connect');
    assert.strictEqual(
      reopenAction({ name: 'a', status: 'Waiting', rawStatus: 'waiting' }),
      'connect',
    );
  });

  test('built-but-stopped workshops start', () => {
    assert.strictEqual(reopenAction({ name: 'a', status: 'Off', rawStatus: 'stopped' }), 'start');
    assert.strictEqual(reopenAction({ name: 'a', status: 'Off', rawStatus: 'STOPPED' }), 'start');
  });

  test('off and definition-only workshops launch', () => {
    assert.strictEqual(reopenAction({ name: 'a', status: 'Off', rawStatus: 'off' }), 'launch');
    // Definition-only: no rawStatus.
    assert.strictEqual(reopenAction({ name: 'a', status: 'Off' }), 'launch');
  });
});

suite('statusIcon mapping', () => {
  const cases: Array<[Parameters<typeof statusIcon>[0], string, string | undefined]> = [
    ['On', 'pass', 'charts.green'],
    ['Waiting', 'watch', 'charts.yellow'],
    ['Error', 'error', 'charts.red'],
    ['Off', 'circle-large-outline', 'disabledForeground'],
    ['Pending', 'loading~spin', undefined],
    ['Unknown', 'circle-large-outline', 'descriptionForeground'],
  ];

  for (const [status, id, color] of cases) {
    test(`${status} -> ${id}`, () => {
      const icon = statusIcon(status);
      assert.ok(icon instanceof vscode.ThemeIcon);
      assert.strictEqual(icon.id, id);
      assert.strictEqual((icon.color as vscode.ThemeColor | undefined)?.id, color);
    });
  }
});
