import * as path from 'path';
import * as vscode from 'vscode';

import { SdkInfo, StoreAccount, WorkshopInfo } from '../api/client';

interface WorkshopInfoItemOptions {
  description?: string;
  tooltip?: string;
  icon?: string;
  iconPath?: vscode.IconPath;
  command?: vscode.Command;
  collapsibleState?: vscode.TreeItemCollapsibleState;
}

const DEFAULT_EXTENSION_URI = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..');

function mediaIcon(extensionUri: vscode.Uri, filename: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', filename);
}

function mediaIconPair(extensionUri: vscode.Uri, basename: string): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: mediaIcon(extensionUri, `${basename}.svg`),
    dark: mediaIcon(extensionUri, `${basename}-dark.svg`),
  };
}

export class WorkshopInfoItem extends vscode.TreeItem {
  /** The workshop this detail item belongs to; stamped by the tree. */
  workshopName?: string;

  constructor(
    label: string,
    readonly children: WorkshopInfoItem[] = [],
    options: WorkshopInfoItemOptions = {},
  ) {
    super(
      label,
      options.collapsibleState ?? (
        children.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      ),
    );
    this.description = options.description;
    this.tooltip = options.tooltip ?? (options.description ? `${label}: ${options.description}` : label);
    if (options.icon) {
      this.iconPath = new vscode.ThemeIcon(options.icon);
    } else if (options.iconPath) {
      this.iconPath = options.iconPath;
    }
    this.command = options.command;
  }
}

export function workshopInfoItems(
  details: WorkshopInfo,
  extensionUri = DEFAULT_EXTENSION_URI,
): WorkshopInfoItem[] {
  const items: WorkshopInfoItem[] = [];

  if (text(details.base)) {
    items.push(new WorkshopInfoItem('Base', [], { description: details.base }));
  }
  if (text(details.hostname)) {
    items.push(new WorkshopInfoItem('Hostname', [], { description: details.hostname }));
  }
  if ((details.notes?.length ?? 0) > 0) {
    items.push(new WorkshopInfoItem(
      'Notes',
      details.notes?.map((note) => new WorkshopInfoItem(note)) ?? [],
      { collapsibleState: vscode.TreeItemCollapsibleState.Expanded },
    ));
  }

  items.push(sdkGroup(details.sdks ?? [], extensionUri));
  return items;
}

export function workshopInfoErrorItems(
  message: string,
  extensionUri = DEFAULT_EXTENSION_URI,
): WorkshopInfoItem[] {
  return [
    new WorkshopInfoItem('Details unavailable', [], {
      description: message,
      tooltip: message,
      icon: 'warning',
    }),
    sdkGroup([], extensionUri),
  ];
}

function sdkGroup(sdks: SdkInfo[], extensionUri: vscode.Uri): WorkshopInfoItem {
  if (sdks.length === 0) {
    return new WorkshopInfoItem('SDKs', [
      new WorkshopInfoItem('No installed SDKs', [], { icon: 'circle-slash' }),
    ], {
      description: 'none',
      iconPath: mediaIconPair(extensionUri, 'sdks'),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    });
  }
  const visible = sdks.filter((sdk) => !isSystemSdk(sdk));
  return new WorkshopInfoItem('SDKs',
    visible.map(sdkItem), {
    description: `${visible.length} installed`,
    iconPath: mediaIconPair(extensionUri, 'sdks'),
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  });
}

function sdkItem(sdk: SdkInfo): WorkshopInfoItem {
  const children: WorkshopInfoItem[] = [];
  const chanLbl = channelLabel(sdk);
  if (!isLocalSdk(sdk) && chanLbl.length > 0) {
    children.push(new WorkshopInfoItem('Channel', [], { description: chanLbl }));
  }

  if (text(sdk.version)) {
    children.push(new WorkshopInfoItem('Version', [], { description: sdk.version }));
  }
  if (text(sdk.revision)) {
    children.push(new WorkshopInfoItem('Revision', [], { description: sdk.revision }));
  }

  const installedAt = text(sdk['installed-at']);
  if (installedAt) {
    children.push(new WorkshopInfoItem('Installed', [], { description: dateTimeLabel(installedAt) }));
  }
  const builtAt = text(sdk['built-at']);
  if (builtAt) {
    children.push(new WorkshopInfoItem('Built', [], { description: dateTimeLabel(builtAt) }));
  }
  if (sdk['health-check']) {
    children.push(new WorkshopInfoItem('Health', [], {
      description: text(sdk['health-check'].code) ?? text(sdk['health-check'].message) ?? 'reported',
      tooltip: sdk['health-check'].message,
      icon: sdk['health-check'].code ? 'warning' : 'heart',
    }));
  }
  const source = text(sdk.source);
  if (source) {
    children.push(new WorkshopInfoItem('Source', [], {
      description: source,
      tooltip: `Click to reveal ${source} in the file manager`,
      command: {
        command: 'revealFileInOS',
        title: 'Reveal in File Manager',
        arguments: [vscode.Uri.file(source)],
      },
    }));
  }

  const website = text(sdk.website);
  if (website) {
    children.push(new WorkshopInfoItem('Website', [], {
      description: website,
      tooltip: `Click to open ${website}`,
      command: {
        command: 'vscode.open',
        title: 'Open Website',
        arguments: [vscode.Uri.parse(website)],
      },
    }));
  }

  const publisher = publisherLabel(sdk.publisher);
  if (publisher) {
    children.push(new WorkshopInfoItem('Publisher', [], {
      description: publisher.verified ? `${publisher.label} ✓` : publisher.label,
    }));
  }

  return new WorkshopInfoItem(sdk.name, children, {
    description: isSystemSdk(sdk) && !text(sdk.channel) ? undefined : trackingLabel(sdk),
  });
}

function text(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function isSystemSdk(sdk: SdkInfo): boolean {
  return sdk.name === 'system';
}

// A revision string mirrors internal/sdk.Revision.String() in the workshop
// daemon: "unset" for the zero value, "x<n>" for a local/sideloaded build,
// or a plain positive integer for a revision installed from the store.
function isLocalSdk(sdk: SdkInfo): boolean {
  return text(sdk.revision)?.startsWith('x') ?? false;
}

function channelLabel(sdk: SdkInfo): string {
  if (!text(sdk.channel) && isSystemSdk(sdk)) {
    return 'no channel';
  }
  return text(sdk.channel) ?? '';
}

// Local/sideloaded SDKs aren't tracking a store channel, so label them with
// their source kind (e.g. "Project", "Try") instead of showing a blank
// channel.
function trackingLabel(sdk: SdkInfo): string {
  if (isLocalSdk(sdk)) {
    const source = text(sdk.source);
    return source ? sourceLabel(source) : 'local';
  }
  return channelLabel(sdk);
}

// The daemon sends a resolved filesystem path rather than the underlying
// source kind (see workshop.SdkSourcePath in internal/workshop/workshop_dirs.go),
// so the kind has to be read back out of the path shape: a try SDK lives
// under a `try/<sdk>` directory, a project SDK under `<project>/.workshop/<sdk>`,
// and a sketch SDK's path always ends in `current`.
function sourceLabel(source: string): string {
  const parent = path.basename(path.dirname(source));
  if (path.basename(source) === 'current') {
    return 'sketch';
  }
  if (parent === 'try') {
    return 'try';
  }
  if (parent === '.workshop') {
    return 'project';
  }
  return source;
}

function publisherLabel(
  publisher: StoreAccount | undefined,
): { label: string; verified: boolean } | undefined {
  const label = text(publisher?.['display-name'])
    ?? text(publisher?.username)
    ?? text(publisher?.id);
  return label
    ? { label, verified: publisher?.validation === 'verified' }
    : undefined;
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
