import * as assert from 'assert';
import * as vscode from 'vscode';

import { mergeWorkshops, normalizeStatus } from '../api/workshops';
import { statusIcon } from '../ui/statusIcon';

suite('workshops model', () => {
  test('normalizeStatus maps known statuses case-insensitively', () => {
    assert.strictEqual(normalizeStatus('ready'), 'Ready');
    assert.strictEqual(normalizeStatus('STOPPED'), 'Stopped');
    assert.strictEqual(normalizeStatus('Waiting'), 'Waiting');
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
      { name: 'beta', status: 'Ready' },
      { name: 'gamma', status: 'Off' },
    ]);
  });

  test('mergeWorkshops tolerates empty response', () => {
    assert.deepStrictEqual(mergeWorkshops({}), []);
  });
});

suite('statusIcon mapping', () => {
  const cases: Array<[Parameters<typeof statusIcon>[0], string, string | undefined]> = [
    ['Ready', 'pass', 'charts.green'],
    ['Waiting', 'watch', 'charts.yellow'],
    ['Error', 'error', 'charts.red'],
    ['Stopped', 'circle-outline', 'descriptionForeground'],
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
