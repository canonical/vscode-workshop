import * as vscode from 'vscode';
import { WorkshopClient, WorkshopInfo, WorkshopNotProjectError, WorkshopUnavailableError } from '../api/client';
import { WorkshopPoller } from '../poller';
import { WorkshopIncompatibleError } from '../version';
import { statusIcon } from './statusIcon';
import { Workshop } from '../api/workshops';
import {
  WorkshopInfoItem,
  workshopInfoErrorItems,
  workshopInfoItems,
} from './workshopDetails';

type WorkshopDetailsClient = Pick<WorkshopClient, 'getWorkshop'> & Partial<Pick<WorkshopClient, 'getSdkInfo'>>;

type DetailState =
  | { kind: 'loading'; requestId: number }
  | { kind: 'loaded'; details: WorkshopInfo }
  | { kind: 'error'; message: string };

/**
 * Context key set to a {@link ViewState} string to drive the view's welcome content
 * (see package.json).
 *
 * This is deliberately a positive-valued key rather than a boolean "available".
 * VS Code normalizes a `key == false` welcome `when` clause into `!key`, which
 * evaluates to `true` while the key is still unset — so a negative key would
 * flash the welcome stub on first paint, before our async `setContext` lands.
 * With a string key, the unset (or empty) state matches no welcome entry.
 */
export const VIEW_STATE_CONTEXT = 'workshop.viewState';

export type ViewState = 'ready' | 'empty' | 'unavailable' | 'incompatible';

/** URI scheme used to key file decorations for workshop tree items. */
const WORKSHOP_ITEM_SCHEME = 'workshop-item';

type ThemeAwareIcon = { light: vscode.Uri; dark: vscode.Uri };
type WorkshopTreeIcon = vscode.ThemeIcon | vscode.Uri | ThemeAwareIcon;

const DEFAULT_EXTENSION_URI = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..');

function mediaIcon(extensionUri: vscode.Uri, filename: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', filename);
}

function mediaIconPair(extensionUri: vscode.Uri, basename: string): ThemeAwareIcon {
  return {
    light: mediaIcon(extensionUri, `${basename}.svg`),
    dark: mediaIcon(extensionUri, `${basename}-dark.svg`),
  };
}

function workshopColor(status: Workshop['status'], active: boolean): vscode.ThemeColor | undefined {
  if (active) {
    return new vscode.ThemeColor(status === 'Waiting' ? 'workshop.waitingForeground' : 'charts.green');
  }
  if (status === 'Waiting') { return new vscode.ThemeColor('workshop.waitingForeground'); }
  if (status === 'Off') { return new vscode.ThemeColor('disabledForeground'); }
  return undefined;
}

/**
 * Provides colored label decorations for workshop tree items.
 * Register with {@link vscode.window.registerFileDecorationProvider}.
 */
export class WorkshopDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private colors = new Map<string, vscode.ThemeColor>();

  update(workshops: Workshop[], activeName: string | undefined): void {
    const previous = this.colors;
    const next = new Map<string, vscode.ThemeColor>();

    for (const workshop of workshops) {
      const color = workshopColor(workshop.status, workshop.name === activeName);
      if (color) {
        const uri = vscode.Uri.from({ scheme: WORKSHOP_ITEM_SCHEME, path: `/${workshop.name}` });
        next.set(uri.toString(), color);
      }
    }

    this.colors = next;

    const allUriStrings = new Set([...previous.keys(), ...next.keys()]);
    const toFire = [...allUriStrings].map((s) => vscode.Uri.parse(s));
    if (toFire.length > 0) { this.emitter.fire(toFire); }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== WORKSHOP_ITEM_SCHEME) { return undefined; }
    const color = this.colors.get(uri.toString());
    return color ? new vscode.FileDecoration(undefined, undefined, color) : undefined;
  }
}

/** Select the tree-row icon based on status and whether this is the active workshop. */
function workshopIcon(
  status: Workshop['status'],
  active: boolean,
  extensionUri: vscode.Uri,
): WorkshopTreeIcon {
  if (active) {
    if (status === 'On') {
      return mediaIconPair(extensionUri, 'workshop-active');
    }
    if (status === 'Waiting') {
      return mediaIconPair(extensionUri, 'workshop-waiting');
    }
  }
  if (status === 'On') {
    return mediaIconPair(extensionUri, 'workshop-ready');
  }
  if (status === 'Waiting') {
    return mediaIconPair(extensionUri, 'workshop-waiting');
  }
  if (status === 'Off') {
    return mediaIconPair(extensionUri, 'workshop-off');
  }
  return statusIcon(status);
}

function canShowWorkshopInfo(status: Workshop['status']): boolean {
  return status === 'On' || status === 'Waiting';
}

/** A single workshop row in the tree. */
export class WorkshopItem extends vscode.TreeItem {
  constructor(
    readonly workshop: Workshop,
    active = false,
    extensionUri = DEFAULT_EXTENSION_URI,
  ) {
    super(
      workshop.name,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.resourceUri = vscode.Uri.from({ scheme: WORKSHOP_ITEM_SCHEME, path: `/${workshop.name}` });
    this.tooltip = workshop.name;
    this.description = workshop.status;
    this.iconPath = workshopIcon(workshop.status, active, extensionUri);
    if (workshop.status === 'Waiting') {
      // A paused-mid-refresh workshop offers continue/abort actions. The active
      // (connected) one is distinguished so its hover buttons can show even
      // inside the workshop; non-active waiting ones only show them locally.
      this.contextValue = active ? 'workshop-active-waiting' : 'workshop-waiting';
    } else if (active) {
      this.contextValue = 'workshop-active';
    } else if (workshop.status === 'Pending') {
      this.contextValue = 'workshop-pending';
    } else if (workshop.status === 'On') {
      // Ready but not the connected one — can be refreshed and reopened.
      this.contextValue = 'workshop-ready';
    } else {
      this.contextValue = 'workshop';
    }
  }
}

/**
 * Renders workshops from a {@link WorkshopPoller}. Data is served from an
 * in-memory cache that the poller keeps up-to-date; `getChildren` is
 * synchronous and never hits the daemon itself.
 *
 * Visibility-gated polling is wired up externally (see `extension.ts`):
 * the caller calls `poller.activate()` when the tree view becomes visible and
 * disposes the handle when it is hidden.
 */
export class WorkshopsTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private cachedItems: Workshop[] = [];
  private readonly details = new Map<string, DetailState>();
  private viewState: ViewState = 'ready';
  private activeWorkshopName: string | undefined;
  private requestId = 0;
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly decorationProvider = new WorkshopDecorationProvider();

  constructor(
    poller: WorkshopPoller<Workshop[]>,
    private readonly client: WorkshopDetailsClient,
    private readonly log?: vscode.LogOutputChannel,
    private readonly extensionUri = DEFAULT_EXTENSION_URI,
  ) {
    this.subscriptions.push(
      poller.onDidUpdate((workshops) => {
        this.pruneDetails(workshops);
        this.cachedItems = workshops;
        const nextState: ViewState = workshops.length === 0 ? 'empty' : 'ready';
        this.viewState = nextState;
        void this.setViewState(nextState);
        this.log?.debug(`Updated ${workshops.length} workshop(s) from poller`);
        this.decorationProvider.update(workshops, this.activeWorkshopName);
        this.emitter.fire();
      }),
      poller.onDidError((err) => {
        if (err instanceof WorkshopUnavailableError) {
          const state: ViewState = err instanceof WorkshopIncompatibleError ? 'incompatible' : 'unavailable';
          this.viewState = state;
          void this.setViewState(state);
          this.log?.warn(
            `Workshop daemon unavailable (${err.code ?? 'no code'}): ${err.message}. ` +
              'Showing the welcome view.',
          );
        } else if (err instanceof WorkshopNotProjectError) {
          // The directory has no workshop files: show the empty welcome instead of a blank panel.
          this.cachedItems = [];
          this.viewState = 'empty';
          void this.setViewState('empty');
          this.log?.debug(`No workshop files found: ${err.message}`);
        } else {
          this.log?.error(`Poller error: ${err.message}`);
        }
        this.emitter.fire();
      }),
    );
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof WorkshopInfoItem) {
      return element.children;
    }
    if (element instanceof WorkshopItem) {
      if (!canShowWorkshopInfo(element.workshop.status)) {
        return [];
      }
      return this.infoChildren(element.workshop);
    }
    if (element) {
      return [];
    }
    if (this.viewState !== 'ready') {
      return [];
    }
    return this.cachedItems.map((w) => {
      const active = w.name === this.activeWorkshopName;
      return new WorkshopItem(w, active, this.extensionUri);
    });
  }

  private key(workshop: Workshop): string {
    return `${workshop.projectId}-${workshop.name}`;
  }

  private pruneDetails(workshops: Workshop[]): void {
    const previous = new Map(this.cachedItems.map((workshop) => [this.key(workshop), workshop]));
    const currentKeys = new Set(workshops.map((workshop) => this.key(workshop)));

    for (const key of this.details.keys()) {
      if (!currentKeys.has(key)) {
        this.details.delete(key);
      }
    }

    for (const workshop of workshops) {
      const key = this.key(workshop);
      const previousWorkshop = previous.get(key);
      if (!previousWorkshop || JSON.stringify(previousWorkshop) !== JSON.stringify(workshop)) {
        this.details.delete(key);
      }
    }
  }

  private infoChildren(workshop: Workshop): WorkshopInfoItem[] {
    const key = this.key(workshop);
    const state = this.details.get(key);
    if (!state) {
      this.loadInfo(workshop);
      return [new WorkshopInfoItem('Loading…', [], { icon: 'sync~spin' })];
    }
    switch (state.kind) {
      case 'loading':
        return [new WorkshopInfoItem('Loading…', [], { icon: 'sync~spin' })];
      case 'error':
        return workshopInfoErrorItems(state.message, this.extensionUri);
      case 'loaded':
        return workshopInfoItems(state.details, this.extensionUri);
    }
  }

  private loadInfo(workshop: Workshop): void {
    const key = this.key(workshop);
    const requestId = ++this.requestId;
    this.details.set(key, { kind: 'loading', requestId });
    void this.withSdkMetadata(this.client.getWorkshop(workshop.projectId, workshop.name))
      .then((details) => {
        const current = this.details.get(key);
        if (current?.kind !== 'loading' || current.requestId !== requestId) {
          return;
        }
        this.details.set(key, { kind: 'loaded', details });
        this.emitter.fire();
      })
      .catch((err: unknown) => {
        const current = this.details.get(key);
        if (current?.kind !== 'loading' || current.requestId !== requestId) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.log?.warn(`Couldn't load workshop info for ${workshop.name}: ${message}`);
        this.details.set(key, { kind: 'error', message });
        this.emitter.fire();
      });
  }

  private async withSdkMetadata(details: Promise<WorkshopInfo>): Promise<WorkshopInfo> {
    const resolved = await details;
    const sdks = resolved.sdks;
    if (!sdks || sdks.length === 0 || !this.client.getSdkInfo) {
      return resolved;
    }

    const enrichedSdks = await Promise.all(sdks.map(async (sdk) => {
      if (sdk.website && sdk.publisher) {
        return sdk;
      }
      try {
        const info = await this.client.getSdkInfo!(sdk.name);
        return {
          ...sdk,
          website: sdk.website ?? info.website,
          publisher: sdk.publisher ?? info.publisher,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log?.debug(`SDK metadata unavailable for ${sdk.name}: ${message}`);
        return sdk;
      }
    }));

    return { ...resolved, sdks: enrichedSdks };
  }

  /** Update which workshop the current window is connected to. */
  setActiveWorkshop(name: string | undefined): void {
    this.activeWorkshopName = name;
    this.decorationProvider.update(this.cachedItems, name);
    this.emitter.fire();
  }

  private setViewState(state: ViewState): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', VIEW_STATE_CONTEXT, state);
  }

  dispose(): void {
    this.emitter.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
  }
}
