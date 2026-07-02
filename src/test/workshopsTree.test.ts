import * as assert from 'assert';
import * as vscode from 'vscode';

import { WorkshopUnavailableError } from '../api/client';
import { WorkshopPoller } from '../poller';
import { Workshop } from '../api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider } from '../ui/workshopsTree';

type ExecuteCommand = typeof vscode.commands.executeCommand;
type MutableCommands = { executeCommand: ExecuteCommand };

/**
 * Intercepts setContext calls for UNAVAILABLE_CONTEXT, runs body,
 * restores the original, then returns every value that was set.
 */
async function captureUnavailable(body: () => Promise<void>): Promise<boolean[]> {
  const original = vscode.commands.executeCommand;
  const captured: boolean[] = [];
  (vscode.commands as MutableCommands).executeCommand = ((command: string, ...args: unknown[]) => {
    if (command === 'setContext' && args[0] === UNAVAILABLE_CONTEXT) {
      captured.push(args[1] as boolean);
      return Promise.resolve(undefined);
    }
    return original(command, ...(args as []));
  }) as ExecuteCommand;

  try {
    await body();
  } finally {
    (vscode.commands as MutableCommands).executeCommand = original;
  }
  return captured;
}

suite('WorkshopsTreeProvider', () => {
  test('renders workshops from the poller cache', async () => {
    const workshops: Workshop[] = [
      { name: 'web', status: 'On' },
      { name: 'db', status: 'Off' },
    ];
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve(workshops), 50_000);
    const provider = new WorkshopsTreeProvider(poller);

    await poller.poll();

    const items = provider.getChildren();
    assert.strictEqual(items.length, 2);
    assert.strictEqual((items[0] as vscode.TreeItem).label, 'web');
    assert.strictEqual((items[1] as vscode.TreeItem).label, 'db');

    poller.dispose();
    provider.dispose();
  });

  test('sets workshop.unavailable=true and shows no items when daemon is unreachable', async () => {
    const err = new WorkshopUnavailableError('socket missing', 'ENOENT');
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.reject(err), 50_000);
    const provider = new WorkshopsTreeProvider(poller);

    let items: vscode.TreeItem[] = [];
    const captured = await captureUnavailable(async () => {
      await poller.poll();
      items = provider.getChildren();
    });

    assert.deepStrictEqual(captured, [true]);
    assert.deepStrictEqual(items, []);

    poller.dispose();
    provider.dispose();
  });

  test('clears workshop.unavailable after a successful update following an error', async () => {
    const err = new WorkshopUnavailableError('socket missing', 'ENOENT');
    let shouldFail = true;
    const poller = new WorkshopPoller<Workshop[]>(
      () =>
        shouldFail
          ? Promise.reject(err)
          : Promise.resolve([{ name: 'web', status: 'On' }]),
      50_000,
    );
    const provider = new WorkshopsTreeProvider(poller);

    const captured = await captureUnavailable(async () => {
      await poller.poll();
      shouldFail = false;
      await poller.poll();
    });

    assert.deepStrictEqual(captured, [true, false]);
    assert.strictEqual(provider.getChildren().length, 1);

    poller.dispose();
    provider.dispose();
  });

  test('sets workshop.unavailable=false on an empty but successful result', async () => {
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve([]), 50_000);
    const provider = new WorkshopsTreeProvider(poller);

    const captured = await captureUnavailable(async () => {
      await poller.poll();
    });

    assert.deepStrictEqual(captured, [false]);
    assert.deepStrictEqual(provider.getChildren(), []);

    poller.dispose();
    provider.dispose();
  });

  test('getChildren on a child element always returns empty', async () => {
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve([]), 50_000);
    const provider = new WorkshopsTreeProvider(poller);
    const fakeChild = new vscode.TreeItem('child');
    assert.deepStrictEqual(provider.getChildren(fakeChild), []);
    poller.dispose();
    provider.dispose();
  });
});
