import * as assert from 'assert';
import * as vscode from 'vscode';

import { PanelData } from '../interfaces/data';
import { MountRow } from '../interfaces/model';
import { ExtToWebview, isWebviewToExt, MenuAction } from '../interfaces/protocol';
import {
  MountsActions,
  MountsPanelProvider,
  renderPanelHtml,
} from '../ui/mountsPanel';

function row(overrides: Partial<MountRow>): MountRow {
  return {
    id: 'host|node:npm-cache|system:mount',
    section: 'host',
    plug: { 'project-id': 'p1', workshop: 'dev', sdk: 'node', plug: 'npm-cache' },
    slot: { 'project-id': 'p1', workshop: 'dev', sdk: 'system', slot: 'mount' },
    connected: true,
    sourceSub: 'system:mount',
    targetSub: 'node:npm-cache',
    menu: [],
    ...overrides,
  };
}

function tableData(rows: MountRow[]): PanelData {
  return {
    body: {
      kind: 'table',
      sections: [{ id: 'host', title: 'Host to Workshop', sourceHeader: 'Host Source', rows }],
    },
  };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeProvider(options: {
  data?: PanelData | ((selection: string | undefined) => PanelData);
  actions?: MountsActions;
  reveal?: (path: string) => void;
}): { provider: MountsPanelProvider; posted: ExtToWebview[]; loads: (string | undefined)[] } {
  const posted: ExtToWebview[] = [];
  const loads: (string | undefined)[] = [];
  const provider = new MountsPanelProvider({
    loadData: async (selection) => {
      loads.push(selection);
      const data = options.data ?? tableData([]);
      return typeof data === 'function' ? data(selection) : data;
    },
    log: silentLog,
    actions: options.actions,
    reveal: options.reveal,
    postOverride: (message) => posted.push(message),
  });
  return { provider, posted, loads };
}

suite('mounts webview protocol guard', () => {
  test('accepts each well-formed message', () => {
    assert.ok(isWebviewToExt({ type: 'ready' }));
    assert.ok(isWebviewToExt({ type: 'toggle', rowId: 'r', desired: true }));
    assert.ok(isWebviewToExt({ type: 'menu', rowId: 'r', action: { kind: 'remount' } }));
    assert.ok(isWebviewToExt({
      type: 'menu',
      rowId: 'r',
      action: { kind: 'connect', slot: { 'project-id': 'p1', workshop: 'dev', sdk: 'uv', slot: 'venv' } },
    }));
    assert.ok(isWebviewToExt({ type: 'reveal', path: '/x' }));
  });

  test('rejects malformed messages', () => {
    assert.ok(!isWebviewToExt(undefined));
    assert.ok(!isWebviewToExt('ready'));
    assert.ok(!isWebviewToExt({ type: 'nope' }));
    assert.ok(!isWebviewToExt({ type: 'toggle', rowId: 'r', desired: 'yes' }));
    assert.ok(!isWebviewToExt({ type: 'menu', rowId: 'r', action: 'remount' }), 'a string action is not a menu item');
    assert.ok(!isWebviewToExt({ type: 'menu', rowId: 'r', action: { kind: 'connect' } }), 'connect needs a slot');
    assert.ok(!isWebviewToExt({ type: 'reveal', path: 42 }));
  });
});

suite('renderPanelHtml', () => {
  const webview = {
    cspSource: 'vscode-resource://csp-source',
    asWebviewUri: (uri: vscode.Uri) => `converted:${uri.path}`,
  };
  const extensionUri = vscode.Uri.file('/ext');

  test('locks the page down with a nonce CSP and no inline script', () => {
    const html = renderPanelHtml(webview, extensionUri, 'NONCE123');
    assert.ok(html.includes("default-src 'none'"));
    assert.ok(html.includes(`style-src ${webview.cspSource}`));
    assert.ok(html.includes("script-src 'nonce-NONCE123'"));
    assert.ok(html.includes('<script nonce="NONCE123" src="converted:/ext/media/mountsPanel.js">'));
    assert.ok(html.includes('converted:/ext/media/mountsPanel.css'));
    assert.ok(!/\son\w+=/.test(html), 'no inline event handlers');
  });

  test('a fresh nonce is minted per render when none is given', () => {
    const a = renderPanelHtml(webview, extensionUri);
    const b = renderPanelHtml(webview, extensionUri);
    const nonceOf = (html: string) => /nonce-([^']+)'/.exec(html)?.[1];
    assert.notStrictEqual(nonceOf(a), nonceOf(b));
  });

  test('carries the skeleton the renderer script expects', () => {
    const html = renderPanelHtml(webview, extensionUri, 'N');
    for (const marker of ['id="content"', 'id="ctxmenu"', 'role="tablist"', 'data-tab="devices"']) {
      assert.ok(html.includes(marker), `missing ${marker}`);
    }
  });
});

suite('MountsPanelProvider', () => {
  test('ready polls and pushes the state', async () => {
    const { provider, posted } = makeProvider({ data: tableData([row({})]) });
    await provider.handleMessage({ type: 'ready' });

    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'state');
    provider.dispose();
  });

  test('setSelectedWorkshop binds the panel to that workshop and polls with it', async () => {
    const { provider, loads } = makeProvider({
      data: () => ({
        body: { kind: 'message', text: 'Loading mounts…' },
      }),
    });
    provider.setSelectedWorkshop('b');
    await provider.poll();

    assert.ok(loads.includes('b'));
    assert.strictEqual(provider.selectedWorkshop, 'b');
    provider.dispose();
  });

  test('toggle without actions settles the burst with ok:false', async () => {
    const { provider, posted } = makeProvider({ data: tableData([row({})]) });
    await provider.handleMessage({ type: 'toggle', rowId: 'host|node:npm-cache|system:mount', desired: false });

    assert.deepStrictEqual(posted, [{
      type: 'actionResult',
      rowId: 'host|node:npm-cache|system:mount',
      ok: false,
    }]);
    provider.dispose();
  });

  test('toggle converges to the desired position and settles once', async () => {
    let connected = true;
    const toggled: boolean[] = [];
    const actions: MountsActions = {
      toggle: async (_row, desired) => {
        toggled.push(desired);
        connected = desired;
      },
      menu: async () => {},
    };
    const { provider, posted } = makeProvider({
      data: () => tableData([row({ connected })]),
      actions,
    });
    await provider.handleMessage({ type: 'ready' });
    posted.length = 0;

    await provider.handleMessage({ type: 'toggle', rowId: 'host|node:npm-cache|system:mount', desired: false });

    assert.deepStrictEqual(toggled, [false]);
    const results = posted.filter((message) => message.type === 'actionResult');
    assert.strictEqual(results.length, 1, 'one actionResult settles the burst');
    assert.deepStrictEqual(results[0], {
      type: 'actionResult',
      rowId: 'host|node:npm-cache|system:mount',
      ok: true,
    });
    provider.dispose();
  });

  test('a failing toggle ends the burst with ok:false', async () => {
    const actions: MountsActions = {
      toggle: async () => {
        throw new Error('daemon said no');
      },
      menu: async () => {},
    };
    const { provider, posted } = makeProvider({ data: () => tableData([row({ connected: true })]), actions });
    await provider.handleMessage({ type: 'ready' });
    posted.length = 0;

    await provider.handleMessage({ type: 'toggle', rowId: 'host|node:npm-cache|system:mount', desired: false });

    const results = posted.filter((message) => message.type === 'actionResult');
    assert.deepStrictEqual(results, [{
      type: 'actionResult',
      rowId: 'host|node:npm-cache|system:mount',
      ok: false,
    }]);
    provider.dispose();
  });

  test('menu actions are re-validated against the row menu extension-side', async () => {
    const invoked: MenuAction[] = [];
    const actions: MountsActions = {
      toggle: async () => {},
      menu: async (_row, action) => {
        invoked.push(action);
      },
    };
    const uvVenv = { 'project-id': 'p1', workshop: 'dev', sdk: 'uv', slot: 'venv' };
    // The row is a disconnected internal mount: no remount, only a connect target.
    const { provider } = makeProvider({
      data: () => tableData([row({
        id: 'workshop|jupyter:venv|uv:venv',
        section: 'workshop',
        connected: false,
        menu: [{ kind: 'connect', slot: uvVenv }],
      })]),
      actions,
    });
    await provider.handleMessage({ type: 'ready' });

    await provider.handleMessage({ type: 'menu', rowId: 'workshop|jupyter:venv|uv:venv', action: { kind: 'remount' } });
    assert.deepStrictEqual(invoked, [], 'remount on an internal mount is dropped');

    await provider.handleMessage({
      type: 'menu',
      rowId: 'workshop|jupyter:venv|uv:venv',
      action: { kind: 'connect', slot: uvVenv },
    });
    assert.deepStrictEqual(invoked, [{ kind: 'connect', slot: uvVenv }]);
    provider.dispose();
  });

  test('reveal goes through the injected opener', async () => {
    const revealed: string[] = [];
    const { provider } = makeProvider({ reveal: (path) => revealed.push(path) });
    await provider.handleMessage({ type: 'reveal', path: '/data/x' });
    assert.deepStrictEqual(revealed, ['/data/x']);
    provider.dispose();
  });

  test('malformed messages are dropped', async () => {
    const { provider, posted, loads } = makeProvider({});
    await provider.handleMessage({ type: 'toggle', rowId: 42 });
    await provider.handleMessage(null);
    assert.deepStrictEqual(posted, []);
    assert.deepStrictEqual(loads, []);
    provider.dispose();
  });
});
