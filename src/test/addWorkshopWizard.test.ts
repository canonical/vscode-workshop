import * as assert from 'assert';
import * as vscode from 'vscode';

import { REFERENCE_SDKS, SDK_CATEGORY_ORDER } from '../api/sdkCatalog';
import {
  basePickItems,
  folderPickItems,
  INVALID_NAME_LABEL,
  nameActionRow,
  sdkPickItems,
} from '../ui/addWorkshopWizard';

suite('Add New Workshop wizard items', () => {
  test('folder rows show the name and path', () => {
    assert.deepStrictEqual(
      folderPickItems([{ name: 'proj', path: '/home/me/proj' }]).map((i) => [i.label, i.description]),
      [['proj', '/home/me/proj']],
    );
  });

  test('SDK rows are grouped by category with summaries and info buttons', () => {
    const items = sdkPickItems();
    const separators = items.filter((i) => i.kind === vscode.QuickPickItemKind.Separator);
    assert.deepStrictEqual(separators.map((i) => i.label), SDK_CATEGORY_ORDER);

    const rows = items.filter((i) => i.kind !== vscode.QuickPickItemKind.Separator);
    assert.deepStrictEqual(rows.map((i) => i.label), REFERENCE_SDKS.map((sdk) => sdk.name));
    assert.deepStrictEqual(rows.map((i) => i.description), REFERENCE_SDKS.map((sdk) => sdk.summary));

    const uv = rows.find((i) => i.label === 'uv');
    const ollama = rows.find((i) => i.label === 'ollama');
    assert.strictEqual(uv?.buttons?.length, 1);
    assert.strictEqual(ollama?.buttons?.length, 1);

    // Each category separator directly precedes its first SDK.
    const first = items.findIndex((i) => i.kind === vscode.QuickPickItemKind.Separator);
    assert.strictEqual(items[first].label, 'AI agents');
    assert.strictEqual(items[first + 1].label, 'agy');
  });

  test('base rows mark the default base, or the newest when it is unavailable', () => {
    assert.deepStrictEqual(
      basePickItems(['ubuntu@26.04', 'ubuntu@24.04']).map((i) => [i.label, i.description]),
      [['ubuntu@24.04', '(default)'], ['ubuntu@26.04', undefined]],
    );
    assert.deepStrictEqual(
      basePickItems(['ubuntu@24.04', 'ubuntu@22.04']).map((i) => [i.label, i.description]),
      [['ubuntu@24.04', '(default)'], ['ubuntu@22.04', undefined]],
    );
  });

  test('name action row follows the typed value', () => {
    const ok = nameActionRow(' dev-2 ');
    assert.strictEqual(ok.label, 'Create workshop dev-2');
    assert.strictEqual(ok.name, 'dev-2');
    assert.strictEqual(ok.valid, true);
    assert.strictEqual(ok.alwaysShow, true);

    const bad = nameActionRow('My Dev');
    assert.strictEqual(bad.label, INVALID_NAME_LABEL);
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(
      bad.detail,
      'Must start with a letter and contain only lowercase letters, digits, and hyphens joining them.',
    );
    assert.strictEqual(nameActionRow('').detail, 'Enter a workshop name.');
    assert.strictEqual(nameActionRow('a'.repeat(41)).detail, 'Name is too long (max 40).');
  });
});
