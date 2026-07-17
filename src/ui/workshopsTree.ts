import * as vscode from 'vscode';
import { SdkInfo, StoreAccount, WorkshopClient, WorkshopInfo, WorkshopUnavailableError } from '../api/client';
import { WorkshopPoller } from '../poller';
import { statusIcon } from './statusIcon';
import { Workshop } from '../api/workshops';

type WorkshopDetailsClient = Pick<WorkshopClient, 'getWorkshop'> & Partial<Pick<WorkshopClient, 'getSdkInfo'>>;

type DetailState =
  | { kind: 'loading'; requestId: number }
  | { kind: 'loaded'; details: WorkshopInfo }
  | { kind: 'error'; message: string };

/**
 * Context key toggled to drive the view's welcome content (see package.json).
 *
 * This is deliberately *positive* ("unavailable") rather than "available". VS
 * Code normalises a `key == false` welcome `when` clause into `!key`, which
 * evaluates to `true` while the key is still unset — so a negative key would
 * flash the welcome stub on first paint, before our async `setContext` lands.
 * With a positive key, the default unset state means "not unavailable", keeping
 * the welcome hidden until the daemon is *confirmed* unreachable.
 */
export const UNAVAILABLE_CONTEXT = 'workshop.unavailable';

/** URI scheme used to key file decorations for workshop tree items. */
const WORKSHOP_ITEM_SCHEME = 'workshop-item';

/**
 * Provides a coloured label decoration for the active workshop tree item.
 * Register with {@link vscode.window.registerFileDecorationProvider}.
 */
export class WorkshopDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private activeUri: vscode.Uri | undefined;
  private activeColor: vscode.ThemeColor | undefined;

  setActive(workshop: Workshop | undefined): void {
    const previous = this.activeUri;
    if (workshop) {
      this.activeUri = vscode.Uri.from({ scheme: WORKSHOP_ITEM_SCHEME, path: `/${workshop.name}` });
      this.activeColor = workshop.status === 'Waiting'
        ? new vscode.ThemeColor('charts.yellow')
        : new vscode.ThemeColor('charts.green');
    } else {
      this.activeUri = undefined;
      this.activeColor = undefined;
    }
    const toFire = [previous, this.activeUri].filter((u): u is vscode.Uri => u !== undefined);
    if (toFire.length > 0) { this.emitter.fire(toFire); }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== WORKSHOP_ITEM_SCHEME) { return undefined; }
    if (this.activeUri && uri.toString() === this.activeUri.toString()) {
      return new vscode.FileDecoration(undefined, undefined, this.activeColor);
    }
    return undefined;
  }
}

/** Select the tree-row icon based on status and whether this is the active workshop. */
function workshopIcon(status: Workshop['status'], active: boolean): vscode.ThemeIcon {
  if (active) {
    if (status === 'Waiting') {
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.yellow'));
    }
    return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
  }
  return statusIcon(status);
}

function text(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function isSystemSdk(sdk: SdkInfo): boolean {
  return sdk.name === 'system';
}

function channelLabel(sdk: SdkInfo): string {
  if (!text(sdk.channel) && isSystemSdk(sdk)) {
    return 'no channel';
  }
  return text(sdk.channel) ?? 'unknown';
}

function publisherLabel(publisher: StoreAccount | undefined): { label: string; verified: boolean } | undefined {
  const label = text(publisher?.['display-name']) ?? text(publisher?.username) ?? text(publisher?.id);
  if (!label) {
    return undefined;
  }
  return { label, verified: publisher?.validation === 'verified' };
}

function dateTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export class WorkshopInfoItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly children: WorkshopInfoItem[] = [],
    options: {
      description?: string;
      tooltip?: string;
      icon?: string;
      command?: vscode.Command;
      collapsibleState?: vscode.TreeItemCollapsibleState;
    } = {},
  ) {
    super(
      label,
      options.collapsibleState ?? (
        children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      ),
    );
    this.description = options.description;
    this.tooltip = options.tooltip ?? (options.description ? `${label}: ${options.description}` : label);
    if (options.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    }
    this.command = options.command;
  }
}

/** A single workshop row in the tree. */
export class WorkshopItem extends vscode.TreeItem {
  constructor(readonly workshop: Workshop, active = false) {
    super(
      workshop.name,
      workshop.status === 'On' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.resourceUri = vscode.Uri.from({ scheme: WORKSHOP_ITEM_SCHEME, path: `/${workshop.name}` });
    this.tooltip = workshop.name;
    this.description = workshop.status;
    this.iconPath = workshopIcon(workshop.status, active);
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
  private isUnavailable = false;
  private activeWorkshopName: string | undefined;
  private requestId = 0;
  private readonly subscriptions: vscode.Disposable[] = [];

  readonly decorationProvider = new WorkshopDecorationProvider();

  constructor(
    poller: WorkshopPoller<Workshop[]>,
    private readonly client: WorkshopDetailsClient,
    private readonly log?: vscode.LogOutputChannel,
  ) {
    this.subscriptions.push(
      poller.onDidUpdate((workshops) => {
        this.pruneDetails(workshops);
        this.cachedItems = workshops;
        this.isUnavailable = false;
        void this.setUnavailable(false);
        this.log?.debug(`Updated ${workshops.length} workshop(s) from poller`);
        // Re-apply decoration in case the active workshop's status changed.
        const active = workshops.find((w) => w.name === this.activeWorkshopName);
        if (active) { this.decorationProvider.setActive(active); }
        this.emitter.fire();
      }),
      poller.onDidError((err) => {
        if (err instanceof WorkshopUnavailableError) {
          this.isUnavailable = true;
          void this.setUnavailable(true);
          this.log?.warn(
            `Workshop daemon unavailable (${err.code ?? 'no code'}): ${err.message}. ` +
              'Showing the welcome view.',
          );
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
      if (element.workshop.status !== 'On') {
        return [];
      }
      return this.infoChildren(element.workshop);
    }
    if (element) {
      return [];
    }
    if (this.isUnavailable) {
      return [];
    }
    return this.cachedItems.map((w) => {
      const active = w.name === this.activeWorkshopName;
      return new WorkshopItem(w, active);
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
      return [new WorkshopInfoItem('Loading...', [], { icon: 'sync~spin' })];
    }
    switch (state.kind) {
      case 'loading':
        return [new WorkshopInfoItem('Loading...', [], { icon: 'sync~spin' })];
      case 'error':
        return this.errorInfoItems(state.message);
      case 'loaded':
        return this.loadedInfoItems(state.details);
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
        this.log?.warn(`Failed to load workshop info for ${workshop.name}: ${message}`);
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

  private loadedInfoItems(details: WorkshopInfo): WorkshopInfoItem[] {
    const items: WorkshopInfoItem[] = [];

    if (text(details.base)) {
      items.push(new WorkshopInfoItem('Base', [], { description: details.base, icon: 'server-environment' }));
    }
    if (text(details.hostname)) {
      items.push(new WorkshopInfoItem('Hostname', [], { description: details.hostname, icon: 'globe' }));
    }
    if ((details.notes?.length ?? 0) > 0) {
      items.push(new WorkshopInfoItem('Notes', details.notes?.map((note) =>
        new WorkshopInfoItem(note, [], { icon: 'note' }),
      ) ?? [], { icon: 'note', collapsibleState: vscode.TreeItemCollapsibleState.Expanded }));
    }

    items.push(this.sdkGroup(details.sdks ?? []));
    return items;
  }

  private errorInfoItems(message: string): WorkshopInfoItem[] {
    return [
      new WorkshopInfoItem('Details unavailable', [], {
        description: message,
        tooltip: message,
        icon: 'warning',
      }),
      this.sdkGroup([]),
    ];
  }

  private sdkGroup(sdks: SdkInfo[]): WorkshopInfoItem {
    if (sdks.length === 0) {
      return new WorkshopInfoItem('SDKs', [
        new WorkshopInfoItem('No installed SDKs', [], { icon: 'circle-slash' }),
      ], {
        description: 'none',
        icon: 'extensions',
        collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      });
    }
    return new WorkshopInfoItem('SDKs', sdks.map((sdk) => this.sdkItem(sdk)), {
      description: `${sdks.length} installed`,
      icon: 'extensions',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    });
  }

  private sdkItem(sdk: SdkInfo): WorkshopInfoItem {
    const children: WorkshopInfoItem[] = [];
    if (!isSystemSdk(sdk)) {
      children.push(new WorkshopInfoItem('Channel', [], { description: channelLabel(sdk), icon: 'versions' }));
    }
    const website = text(sdk.website);
    const publisher = publisherLabel(sdk.publisher);
    if (website) {
      children.push(new WorkshopInfoItem('Website', [], {
        description: website,
        icon: 'link-external',
        command: {
          command: 'vscode.open',
          title: 'Open Website',
          arguments: [vscode.Uri.parse(website)],
        },
      }));
    }
    if (publisher) {
      children.push(new WorkshopInfoItem('Publisher', [], {
        description: publisher.label,
        icon: publisher.verified ? 'verified' : 'account',
      }));
    }
    if (text(sdk.version)) {
      children.push(new WorkshopInfoItem('Version', [], { description: sdk.version, icon: 'tag' }));
    }
    if (text(sdk.revision)) {
      children.push(new WorkshopInfoItem('Revision', [], { description: sdk.revision, icon: 'git-commit' }));
    }
    const installedAt = text(sdk['installed-at']);
    if (installedAt) {
      children.push(new WorkshopInfoItem('Installed', [], { description: dateTimeLabel(installedAt), icon: 'calendar' }));
    }
    const builtAt = text(sdk['built-at']);
    if (builtAt) {
      children.push(new WorkshopInfoItem('Built', [], { description: dateTimeLabel(builtAt), icon: 'tools' }));
    }
    if (sdk['health-check']) {
      children.push(new WorkshopInfoItem('Health', [], {
        description: text(sdk['health-check'].code) ?? text(sdk['health-check'].message) ?? 'reported',
        tooltip: sdk['health-check'].message,
        icon: sdk['health-check'].code ? 'warning' : 'heart',
      }));
    }
    if (text(sdk.source)) {
      children.push(new WorkshopInfoItem('Source', [], { description: sdk.source, icon: 'folder' }));
    }
    return new WorkshopInfoItem(sdk.name, children, {
      description: isSystemSdk(sdk) && !text(sdk.channel) ? undefined : channelLabel(sdk),
      icon: 'package',
    });
  }

  /** Update which workshop the current window is connected to. */
  setActiveWorkshop(name: string | undefined): void {
    this.activeWorkshopName = name;
    const active = name ? this.cachedItems.find((w) => w.name === name) : undefined;
    this.decorationProvider.setActive(active);
    this.emitter.fire();
  }

  private setUnavailable(unavailable: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', UNAVAILABLE_CONTEXT, unavailable);
  }

  dispose(): void {
    this.emitter.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
  }
}
