import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { slotKey } from '../api/connections';
import { PanelData } from '../interfaces/data';
import { MountRow } from '../interfaces/model';
import { ExtToWebview, isWebviewToExt, MenuAction } from '../interfaces/protocol';
import { WorkshopPoller } from '../poller';

export const MOUNTS_VIEW_ID = 'workshop.mounts';

/** Minimal logging surface so tests can pass a plain object. */
export interface MountsLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Row actions — injected in the actions stage; absent until then, in which
 * case toggles settle immediately with `ok: false` (the switch snaps back)
 * and menu actions are ignored.
 */
export interface MountsActions {
  /** Converge the row toward the desired position once; daemon truth wins. */
  toggle(row: MountRow, desired: boolean): Promise<void>;
  menu(row: MountRow, action: MenuAction): Promise<void>;
}

export interface MountsPanelDeps {
  /** One tick: fetch the panel data for the given selection. */
  loadData(selection: string | undefined): Promise<PanelData>;
  log: MountsLog;
  actions?: MountsActions;
  /** Reveal a host path in the OS file manager. */
  reveal?(path: string): void;
  intervalMs?: number;
  /** Test seam: capture outbound messages instead of a live webview. */
  postOverride?(message: ExtToWebview): void;
}

/**
 * Webview view provider for the Mounts tab of the Workshop panel. Owns the
 * PanelData poller (activated only while the view is visible), the current
 * workshop selection (reset when the view is disposed — selection is never
 * restored on reopen), and the message handling for the webview protocol.
 *
 * The webview is untrusted: every inbound message is shape-checked and menu
 * actions are re-validated against the current row's menu extension-side.
 */
export class MountsPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly poller: WorkshopPoller<PanelData>;
  private view: vscode.WebviewView | undefined;
  private activationHandle: vscode.Disposable | undefined;
  /** The workshop selected in the tree; set by the extension. */
  private selected: string | undefined;
  /** Rows whose menu action is running — guards double-opened dialogs. */
  private readonly menuInFlight = new Set<string>();
  /** Latest desired position per row while a toggle burst converges. */
  private readonly desiredByRow = new Map<string, boolean>();

  constructor(
    private readonly deps: MountsPanelDeps,
    private readonly extensionUri?: vscode.Uri,
  ) {
    this.poller = new WorkshopPoller<PanelData>(
      () => this.deps.loadData(this.selected),
      deps.intervalMs ?? 3_000,
    );
    this.poller.onDidUpdate((data) => {
      this.post({ type: 'state', state: data });
    });
    this.poller.onDidError((err) => {
      // The last pushed state stays on screen; just log.
      this.deps.log.warn(`Mounts poll failed: ${err.message}`);
    });
  }

  /** The workshop the panel is bound to (provider-held, never persisted). */
  get selectedWorkshop(): string | undefined {
    return this.selected;
  }

  /**
   * Bind the panel to the workshop selected in the tree. Refreshes
   * immediately when the view is live so the change is reflected without
   * waiting for the next interval tick.
   */
  setSelectedWorkshop(name: string | undefined): void {
    if (name === this.selected) {
      return;
    }
    this.selected = name;
    if (this.activationHandle !== undefined) {
      void this.poller.poll();
    }
  }

  get lastData(): PanelData | undefined {
    return this.poller.lastValue;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: this.extensionUri
        ? [vscode.Uri.joinPath(this.extensionUri, 'media')]
        : [],
    };
    view.webview.html = this.extensionUri
      ? renderPanelHtml(view.webview, this.extensionUri)
      : '';
    view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
    view.onDidChangeVisibility(() => this.updateActivation(view.visible));
    view.onDidDispose(() => {
      this.view = undefined;
      this.updateActivation(false);
    });
    this.updateActivation(view.visible);
  }

  private updateActivation(visible: boolean): void {
    if (visible) {
      this.activationHandle ??= this.poller.activate();
    } else {
      this.activationHandle?.dispose();
      this.activationHandle = undefined;
    }
  }

  /** Handle one message from the webview. Public for tests. */
  async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewToExt(message)) {
      this.deps.log.warn('Mounts panel dropped a malformed webview message');
      return;
    }
    switch (message.type) {
      case 'ready': {
        const last = this.poller.lastValue;
        if (last !== undefined) {
          this.post({ type: 'state', state: last });
        }
        await this.poller.poll();
        return;
      }
      case 'toggle':
        await this.handleToggle(message.rowId, message.desired);
        return;
      case 'menu':
        await this.handleMenu(message.rowId, message.action);
        return;
      case 'reveal':
        this.deps.reveal?.(message.path);
        return;
    }
  }

  /**
   * Converge the daemon toward the most recent desired position for the
   * row (AC 14): one worker per row loops "shown state ≠ latest desired →
   * issue one toggle → refresh → re-check", coalescing rapid flips to the
   * last position. One actionResult settles the whole burst. A small
   * iteration cap makes a disagreeing daemon snap the switch back instead
   * of looping forever.
   */
  private async handleToggle(rowId: string, desired: boolean): Promise<void> {
    const alreadyRunning = this.desiredByRow.has(rowId);
    this.desiredByRow.set(rowId, desired);
    if (alreadyRunning) {
      return; // the running worker picks up the new desired position
    }
    const actions = this.deps.actions;
    if (actions === undefined) {
      this.desiredByRow.delete(rowId);
      this.post({ type: 'actionResult', rowId, ok: false });
      return;
    }

    let ok = true;
    try {
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const row = this.findRow(rowId);
        const wanted = this.desiredByRow.get(rowId);
        if (row === undefined || wanted === undefined || row.connected === wanted) {
          return;
        }
        await actions.toggle(row, wanted);
        await this.poller.poll();
      }
    } catch (err) {
      // The failure ends the burst; the toast/log/fallback-modal live in
      // the actions layer. The switch settles to daemon truth below.
      ok = false;
      this.deps.log.warn(`Toggle failed for ${rowId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.desiredByRow.delete(rowId);
      this.post({ type: 'actionResult', rowId, ok });
    }
  }

  private async handleMenu(rowId: string, action: MenuAction): Promise<void> {
    const actions = this.deps.actions;
    if (actions === undefined) {
      return;
    }
    const row = this.findRow(rowId);
    // Re-validate against the row's own menu: the webview is untrusted, and
    // e.g. Remount must never run on an internal mount.
    if (row === undefined || !menuHasAction(row, action)) {
      this.deps.log.warn(`Mounts panel dropped menu action ${action.kind} for ${rowId}`);
      return;
    }
    if (this.menuInFlight.has(rowId)) {
      return; // two fast clicks must not stack folder dialogs
    }
    this.menuInFlight.add(rowId);
    try {
      await actions.menu(row, action);
    } catch (err) {
      this.deps.log.error(
        `Mounts ${action} failed for ${rowId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.menuInFlight.delete(rowId);
      await this.poller.poll();
    }
  }

  private findRow(rowId: string): MountRow | undefined {
    const data = this.poller.lastValue;
    if (data === undefined || data.body.kind !== 'table') {
      return undefined;
    }
    for (const section of data.body.sections) {
      const row = section.rows.find((candidate) => candidate.id === rowId);
      if (row !== undefined) {
        return row;
      }
    }
    return undefined;
  }

  private post(message: ExtToWebview): void {
    if (this.deps.postOverride) {
      this.deps.postOverride(message);
      return;
    }
    void this.view?.webview.postMessage(message);
  }

  /** Trigger an immediate refresh (used by the actions layer). */
  poll(): Promise<void> {
    return this.poller.poll();
  }

  dispose(): void {
    this.activationHandle?.dispose();
    this.activationHandle = undefined;
    this.poller.dispose();
  }
}

/** Whether `action` corresponds to a real menu item on the row. */
function menuHasAction(row: MountRow, action: MenuAction): boolean {
  if (action.kind === 'remount') {
    return row.menu.some((item) => item.kind === 'remount');
  }
  const target = slotKey(action.slot);
  return row.menu.some((item) => item.kind === 'connect' && slotKey(item.slot) === target);
}

/** Webview surface needed to build the page — test-friendly subset. */
export interface HtmlWebview {
  cspSource: string;
  asWebviewUri(uri: vscode.Uri): { toString(): string };
}

/**
 * The static page: skeleton elements the renderer script fills in. Content
 * security: no inline code — styles only from the extension's media root,
 * scripts only with the per-resolve nonce.
 */
export function renderPanelHtml(
  webview: HtmlWebview,
  extensionUri: vscode.Uri,
  nonce: string = crypto.randomBytes(16).toString('base64'),
): string {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mountsPanel.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'mountsPanel.js'));
  const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri.toString()}">
<title>Mounts</title>
</head>
<body>
<div class="tabs" role="tablist" aria-label="Workshop panel tabs">
  <button class="tab active" role="tab" aria-selected="true" data-tab="mounts">Mounts</button>
  <button class="tab" role="tab" aria-selected="false" data-tab="devices" tabindex="-1">Devices</button>
</div>
<div id="content"></div>
<div class="ctxmenu" id="ctxmenu" role="menu"></div>
<script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
}
