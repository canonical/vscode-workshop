import * as assert from 'assert';
import * as vscode from 'vscode';

import { mergeWorkshops, normalizeStatus } from '../api/workshops';
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
        { 'project-id': 'p', name: 'beta', status: 'ready' },
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
      { name: 'alpha', status: 'Waiting' },
      { name: 'beta', status: 'On' },
      { name: 'gamma', status: 'Off' },
    ]);
  });

  test('mergeWorkshops tolerates empty response', () => {
    assert.deepStrictEqual(mergeWorkshops({}), []);
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
