import * as vscode from 'vscode';

import { WorkshopClient } from './api/client';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { WorkshopPoller } from './poller';
import { assertWorkshopVersionCompatible } from './version';
import { createDefinitionWatcher } from './ui/definitionWatcher';
import { LogsView } from './ui/logsView';
import {
  VIEW_STATE_CONTEXT,
  WorkshopsTreeProvider,
  WorkshopItem,
} from './ui/workshopsTree';
import { createWorkshopCommands } from './workshopCommands';
import {
  currentWorkshop,
  isWorkshopWindow,
  resolveCurrentProjectId,
} from './workspaceContext';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  void vscode.commands.executeCommand('setContext', VIEW_STATE_CONTEXT, 'ready');

  const logsView = new LogsView();
  logsView.register(context);

  const poller = new WorkshopPoller<Workshop[]>(async () => {
    await assertWorkshopVersionCompatible(client, log);
    const projectId = await resolveCurrentProjectId(client, context.globalState);
    return projectId ? listProjectWorkshops(client, projectId) : [];
  });

  const provider = new WorkshopsTreeProvider(poller, client, log, context.extensionUri);
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
    const workshopName = currentWorkshop(context.globalState)?.session?.workshopName;
    if (workshopName) {
      provider.setActiveWorkshop(workshopName);
    }
  }

  if (treeView.visible) {
    onViewVisible();
  }
  if (!isWorkshopWindow()) {
    workshopCommands.activateLocalProject();
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
