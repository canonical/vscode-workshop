import * as vscode from 'vscode';

import { WorkshopClient } from './api/client';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { WorkshopPoller } from './poller';
import { hostnameFromFolder, readSession } from './state';
import { createDefinitionWatcher } from './ui/definitionWatcher';
import { LogsView } from './ui/logsView';
import {
  UNAVAILABLE_CONTEXT,
  WorkshopsTreeProvider,
  WorkshopItem,
} from './ui/workshopsTree';
import { createWorkshopCommands } from './workshopCommands';

const isWorkshop = () => vscode.env.remoteName === 'ssh-remote';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  void vscode.commands.executeCommand('setContext', UNAVAILABLE_CONTEXT, false);

  const logsView = new LogsView();
  logsView.register(context);

  const poller = new WorkshopPoller<Workshop[]>(() => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return Promise.resolve([]);
    }
    if (isWorkshop()) {
      const hostname = hostnameFromFolder(folder);
      const projectId = hostname ? readSession(context.globalState, hostname)?.projectId : undefined;
      if (!projectId) {
        return Promise.resolve([]);
      }
      return listProjectWorkshops(client, projectId);
    }
    return client.ensureProject(folder.uri.fsPath)
      .then((project) => listProjectWorkshops(client, project.id));
  });

  const provider = new WorkshopsTreeProvider(poller, client, log);
  const treeView = vscode.window.createTreeView('workshop.workshops', {
    treeDataProvider: provider,
  });
  const workshopCommands = createWorkshopCommands({
    client,
    globalState: context.globalState,
    log,
    logsView,
  });

  function updateTreeViewTitle(): void {
    treeView.title = vscode.workspace.name ?? undefined;
  }
  updateTreeViewTitle();

  let activationHandle: vscode.Disposable | undefined;
  function onViewVisible(): void {
    activationHandle ??= poller.activate();
    if (isWorkshop()) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const hostname = hostnameFromFolder(folder);
      const workshopName = hostname
        ? readSession(context.globalState, hostname)?.workshopName
        : undefined;
      if (workshopName) {
        provider.setActiveWorkshop(workshopName);
      }
    }
  }

  if (treeView.visible) {
    onViewVisible();
  }
  if (!isWorkshop()) {
    workshopCommands.resumePendingOperation();
  }

  context.subscriptions.push(
    log,
    poller,
    provider,
    treeView,
    vscode.workspace.onDidChangeWorkspaceFolders(updateTreeViewTitle),
    vscode.window.registerFileDecorationProvider(provider.decorationProvider),
    treeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        onViewVisible();
      } else {
        activationHandle?.dispose();
        activationHandle = undefined;
      }
    }),
    createDefinitionWatcher((filePath) => {
      workshopCommands.definitionChanged(filePath, poller.lastValue);
    }),
    vscode.commands.registerCommand('workshop.poll', () => void poller.poll()),
    vscode.commands.registerCommand('workshop.install', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://snapcraft.io/workshop')),
    ),
    vscode.commands.registerCommand(
      'workshop.reopenInWorkshop',
      (item: WorkshopItem) => workshopCommands.reopenInWorkshop(item),
    ),
    vscode.commands.registerCommand(
      'workshop.reopenLocally',
      () => workshopCommands.reopenLocally(),
    ),
    vscode.commands.registerCommand(
      'workshop.refreshAndReopen',
      (item: WorkshopItem) => workshopCommands.refresh(item),
    ),
    vscode.commands.registerCommand(
      'workshop.continueRefresh',
      (item: WorkshopItem) => workshopCommands.refresh(item, 'continue'),
    ),
    vscode.commands.registerCommand(
      'workshop.abortRefresh',
      (item: WorkshopItem) => workshopCommands.refresh(item, 'abort'),
    ),
    vscode.commands.registerCommand(
      'workshop.openDefinition',
      (arg: WorkshopItem | string) => workshopCommands.openDefinition(arg),
    ),
    vscode.commands.registerCommand(
      'workshop.turnOff',
      (item: WorkshopItem) => workshopCommands.turnOff(item),
    ),
  );
}

export function deactivate(): void {}
