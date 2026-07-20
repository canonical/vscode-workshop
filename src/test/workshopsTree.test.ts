import * as assert from 'assert';
import * as vscode from 'vscode';

import { WorkshopInfo, WorkshopUnavailableError } from '../api/client';
import { WorkshopPoller } from '../poller';
import { Workshop } from '../api/workshops';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider } from '../ui/workshopsTree';

const fakeDetailsClient = {
  getWorkshop: async (projectId: string, name: string): Promise<WorkshopInfo> => ({
    'project-id': projectId,
    name,
    status: 'ready',
    sdks: [],
  }),
};

type ExecuteCommand = typeof vscode.commands.executeCommand;
type MutableCommands = { executeCommand: ExecuteCommand };
type ThemeAwareIcon = { light: vscode.Uri; dark: vscode.Uri };

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
      { name: 'web', status: 'On', projectId: 'proj-1' },
      { name: 'db', status: 'Off', projectId: 'proj-1' },
    ];
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve(workshops), 50_000);
    const provider = new WorkshopsTreeProvider(poller, fakeDetailsClient);

    await poller.poll();

    const items = provider.getChildren();
    assert.strictEqual(items.length, 2);
    assert.strictEqual((items[0] as vscode.TreeItem).label, 'web');
    assert.strictEqual((items[1] as vscode.TreeItem).label, 'db');

    poller.dispose();
    provider.dispose();
  });

  test('uses workshop SVG icons by tree status', async () => {
    const workshops: Workshop[] = [
      { name: 'web', status: 'On', projectId: 'proj-1' },
      { name: 'api', status: 'On', projectId: 'proj-1' },
      { name: 'db', status: 'Off', projectId: 'proj-1' },
      { name: 'cache', status: 'Waiting', projectId: 'proj-1' },
    ];
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve(workshops), 50_000);
    const extensionUri = vscode.Uri.file('/extension');
    const provider = new WorkshopsTreeProvider(poller, fakeDetailsClient, undefined, extensionUri);

    await poller.poll();
    provider.setActiveWorkshop('web');

    const items = provider.getChildren() as vscode.TreeItem[];
    const icons = new Map(items.map((item) => {
      const icon = item.iconPath as ThemeAwareIcon;
      return [
        item.label,
        { light: icon.light.path, dark: icon.dark.path },
      ];
    }));

    assert.deepStrictEqual(icons.get('web'), {
      light: '/extension/media/workshop-active.svg',
      dark: '/extension/media/workshop-active-dark.svg',
    });
    assert.deepStrictEqual(icons.get('api'), {
      light: '/extension/media/workshop-ready.svg',
      dark: '/extension/media/workshop-ready-dark.svg',
    });
    assert.deepStrictEqual(icons.get('db'), {
      light: '/extension/media/workshop-off.svg',
      dark: '/extension/media/workshop-off-dark.svg',
    });
    assert.deepStrictEqual(icons.get('cache'), {
      light: '/extension/media/workshop-waiting.svg',
      dark: '/extension/media/workshop-waiting-dark.svg',
    });

    poller.dispose();
    provider.dispose();
  });

  test('sets workshop.unavailable=true and shows no items when daemon is unreachable', async () => {
    const err = new WorkshopUnavailableError('socket missing', 'ENOENT');
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.reject(err), 50_000);
    const provider = new WorkshopsTreeProvider(poller, fakeDetailsClient);

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
          : Promise.resolve([{ name: 'web', status: 'On', projectId: 'proj-1' }]),
      50_000,
    );
    const provider = new WorkshopsTreeProvider(poller, fakeDetailsClient);

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
    const provider = new WorkshopsTreeProvider(poller, fakeDetailsClient);

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
    const provider = new WorkshopsTreeProvider(poller, fakeDetailsClient);
    const fakeChild = new vscode.TreeItem('child');
    assert.deepStrictEqual(provider.getChildren(fakeChild), []);
    poller.dispose();
    provider.dispose();
  });

  test('loads workshop details as child rows when a workshop is expanded', async () => {
    const workshops: Workshop[] = [{ name: 'web', status: 'On', projectId: 'proj-1' }];
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve(workshops), 50_000);
    const extensionUri = vscode.Uri.file('/extension');
    const provider = new WorkshopsTreeProvider(poller, {
      getWorkshop: async () => ({
        'project-id': 'proj-1',
        name: 'web',
        base: 'ubuntu@24.04',
        status: 'ready',
        hostname: 'web.wp',
        sdks: [{ name: 'node', channel: '22/stable' }],
      }),
    }, undefined, extensionUri);

    await poller.poll();
    const workshop = provider.getChildren()[0];
    const loading = provider.getChildren(workshop);
    assert.strictEqual((loading[0] as vscode.TreeItem).label, 'Loading...');
    await new Promise((resolve) => setImmediate(resolve));

    const children = provider.getChildren(workshop);
    assert.strictEqual(children.some((item) => (item as vscode.TreeItem).label === 'Base'), true);
    assert.strictEqual(children.some((item) => (item as vscode.TreeItem).label === 'Hostname'), true);
    const sdks = children.find((item) => (item as vscode.TreeItem).label === 'SDKs') as vscode.TreeItem | undefined;
    assert.ok(sdks);
    const sdksIcon = sdks.iconPath as ThemeAwareIcon;
    assert.deepStrictEqual({
      light: sdksIcon.light.path,
      dark: sdksIcon.dark.path,
    }, {
      light: '/extension/media/sdks.svg',
      dark: '/extension/media/sdks-dark.svg',
    });
    const sdkChildren = provider.getChildren(sdks);
    assert.strictEqual((sdkChildren[0] as vscode.TreeItem).label, 'node');
    assert.strictEqual((sdkChildren[0] as vscode.TreeItem).iconPath, undefined);

    poller.dispose();
    provider.dispose();
  });

  test('uses verified icon only for verified SDK publishers', async () => {
    const workshops: Workshop[] = [{ name: 'web', status: 'On', projectId: 'proj-1' }];
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve(workshops), 50_000);
    const provider = new WorkshopsTreeProvider(poller, {
      getWorkshop: async () => ({
        'project-id': 'proj-1',
        name: 'web',
        status: 'ready',
        sdks: [
          {
            name: 'verified-sdk',
            channel: 'latest/stable',
            website: 'https://example.com',
            version: '1.0.0',
            publisher: { username: 'canonical', validation: 'verified' },
          },
          {
            name: 'community-sdk',
            publisher: { username: 'community' },
          },
        ],
      }),
    });

    await poller.poll();
    const workshop = provider.getChildren()[0];
    provider.getChildren(workshop);
    await new Promise((resolve) => setImmediate(resolve));

    const sdkGroup = provider.getChildren(workshop)
      .find((item) => (item as vscode.TreeItem).label === 'SDKs') as vscode.TreeItem;
    const sdks = provider.getChildren(sdkGroup) as vscode.TreeItem[];
    const verifiedSdk = sdks.find((item) => item.label === 'verified-sdk') as vscode.TreeItem;
    const communitySdk = sdks.find((item) => item.label === 'community-sdk') as vscode.TreeItem;

    const verifiedPublisher = provider.getChildren(verifiedSdk)
      .find((item) => (item as vscode.TreeItem).label === 'Publisher') as vscode.TreeItem;
    const communityPublisher = provider.getChildren(communitySdk)
      .find((item) => (item as vscode.TreeItem).label === 'Publisher') as vscode.TreeItem;
    const verifiedSdkChildren = provider.getChildren(verifiedSdk) as vscode.TreeItem[];

    assert.strictEqual((verifiedPublisher.iconPath as vscode.ThemeIcon).id, 'verified');
    assert.strictEqual(communityPublisher.iconPath, undefined);
    assert.deepStrictEqual(
      verifiedSdkChildren.slice(-2).map((item) => item.label),
      ['Website', 'Publisher'],
    );

    poller.dispose();
    provider.dispose();
  });

  test('reloads workshop details after a poller update', async () => {
    let webRawStatus = 'ready';
    let dbRawStatus = 'ready';
    const calls = new Map<string, number>();
    const poller = new WorkshopPoller<Workshop[]>(
      () => Promise.resolve([
        { name: 'web', status: 'On', rawStatus: webRawStatus, projectId: 'proj-1' },
        { name: 'db', status: 'On', rawStatus: dbRawStatus, projectId: 'proj-1' },
      ]),
      50_000,
    );
    const provider = new WorkshopsTreeProvider(poller, {
      getWorkshop: async (_projectId: string, name: string) => {
        const count = (calls.get(name) ?? 0) + 1;
        calls.set(name, count);
        return {
          'project-id': 'proj-1',
          name,
          base: `${name}-${count}`,
          status: 'ready',
          sdks: [],
        };
      },
    });

    await poller.poll();
    let workshops = provider.getChildren();
    let web = workshops.find((item) => (item as vscode.TreeItem).label === 'web') as vscode.TreeItem;
    let db = workshops.find((item) => (item as vscode.TreeItem).label === 'db') as vscode.TreeItem;
    provider.getChildren(web);
    provider.getChildren(db);
    await new Promise((resolve) => setImmediate(resolve));

    let webBase = provider.getChildren(web)
      .find((item) => (item as vscode.TreeItem).label === 'Base') as vscode.TreeItem;
    let dbBase = provider.getChildren(db)
      .find((item) => (item as vscode.TreeItem).label === 'Base') as vscode.TreeItem;
    assert.strictEqual(webBase.description, 'web-1');
    assert.strictEqual(dbBase.description, 'db-1');

    webRawStatus = 'refreshed';
    dbRawStatus = 'ready';
    await poller.poll();
    workshops = provider.getChildren();
    web = workshops.find((item) => (item as vscode.TreeItem).label === 'web') as vscode.TreeItem;
    db = workshops.find((item) => (item as vscode.TreeItem).label === 'db') as vscode.TreeItem;
    const loading = provider.getChildren(web);
    assert.strictEqual((loading[0] as vscode.TreeItem).label, 'Loading...');
    dbBase = provider.getChildren(db)
      .find((item) => (item as vscode.TreeItem).label === 'Base') as vscode.TreeItem;
    assert.strictEqual(dbBase.description, 'db-1');
    await new Promise((resolve) => setImmediate(resolve));

    webBase = provider.getChildren(web)
      .find((item) => (item as vscode.TreeItem).label === 'Base') as vscode.TreeItem;
    assert.strictEqual(webBase.description, 'web-2');
    assert.strictEqual(calls.get('web'), 2);
    assert.strictEqual(calls.get('db'), 1);

    poller.dispose();
    provider.dispose();
  });

  test('shows a disclosure slot but no info children for non-ready workshops', async () => {
    let calls = 0;
    const workshops: Workshop[] = [{ name: 'web', status: 'Off', projectId: 'proj-1' }];
    const poller = new WorkshopPoller<Workshop[]>(() => Promise.resolve(workshops), 50_000);
    const provider = new WorkshopsTreeProvider(poller, {
      getWorkshop: async () => {
        calls += 1;
        throw new Error('should not be called');
      },
    });

    await poller.poll();
    const workshop = provider.getChildren()[0] as vscode.TreeItem;
    assert.strictEqual(workshop.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.deepStrictEqual(provider.getChildren(workshop), []);
    assert.strictEqual(calls, 0);

    poller.dispose();
    provider.dispose();
  });
});
