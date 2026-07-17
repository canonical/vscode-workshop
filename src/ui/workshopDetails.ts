import * as vscode from 'vscode';

import { SdkInfo, StoreAccount, WorkshopInfo } from '../api/client';

interface WorkshopInfoItemOptions {
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: vscode.Command;
  collapsibleState?: vscode.TreeItemCollapsibleState;
}

export class WorkshopInfoItem extends vscode.TreeItem {
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
    }
    this.command = options.command;
  }
}

export function workshopInfoItems(details: WorkshopInfo): WorkshopInfoItem[] {
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

  items.push(sdkGroup(details.sdks ?? []));
  return items;
}

export function workshopInfoErrorItems(message: string): WorkshopInfoItem[] {
  return [
    new WorkshopInfoItem('Details unavailable', [], {
      description: message,
      tooltip: message,
      icon: 'warning',
    }),
    sdkGroup([]),
  ];
}

function sdkGroup(sdks: SdkInfo[]): WorkshopInfoItem {
  if (sdks.length === 0) {
    return new WorkshopInfoItem('SDKs', [
      new WorkshopInfoItem('No installed SDKs', [], { icon: 'circle-slash' }),
    ], {
      description: 'none',
      icon: 'extensions',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    });
  }
  return new WorkshopInfoItem('SDKs', sdks.map(sdkItem), {
    description: `${sdks.length} installed`,
    icon: 'extensions',
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
  });
}

function sdkItem(sdk: SdkInfo): WorkshopInfoItem {
  const children: WorkshopInfoItem[] = [];
  if (!isSystemSdk(sdk)) {
    children.push(new WorkshopInfoItem('Channel', [], { description: channelLabel(sdk) }));
  }

  const website = text(sdk.website);
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

  const publisher = publisherLabel(sdk.publisher);
  if (publisher) {
    children.push(new WorkshopInfoItem('Publisher', [], {
      description: publisher.label,
      icon: publisher.verified ? 'verified' : undefined,
    }));
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
  if (text(sdk.source)) {
    children.push(new WorkshopInfoItem('Source', [], { description: sdk.source }));
  }

  return new WorkshopInfoItem(sdk.name, children, {
    description: isSystemSdk(sdk) && !text(sdk.channel) ? undefined : channelLabel(sdk),
    icon: 'package',
  });
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
