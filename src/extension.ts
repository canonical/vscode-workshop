import * as vscode from 'vscode';

import { WorkshopClient } from './api/client';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { createMountsActions } from './interfaces/actions';
import { fetchPanelData, PanelData } from './interfaces/data';
import { MSG_NO_WORKSHOPS } from './interfaces/panelState';
import { WorkshopOperationQueue } from './interfaces/queue';
import { WorkshopPoller } from './poller';
import { assertWorkshopVersionCompatible } from './version';
import { createDefinitionWatcher } from './ui/definitionWatcher';
import { LogsView } from './ui/logsView';
import { MOUNTS_VIEW_ID, MountsPanelProvider } from './ui/mountsPanel';
import { createMountsUi } from './ui/mountsUi';
import {
  VIEW_STATE_CONTEXT,
  WorkshopsTreeProvider,
  WorkshopItem,
} from './ui/workshopsTree';
import { createWorkshopCommands } from './workshopCommands';
import {
  currentWorkshop,
  isWorkshopWindow,
  ProjectContext,
  withProjectRetry,
} from './workspaceContext';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  void vscode.commands.executeCommand('setContext', VIEW_STATE_CONTEXT, 'ready');

  const logsView = new LogsView();
  logsView.register(context);

  // Resolved once here (and re-resolved on workspace change / stale id via
  // ProjectContext) — never per poll tick.
  const projects = new ProjectContext(client, context.globalState);
  void projects.resolveNow().catch(() => {
    // The daemon may not be up yet; the next getId() retries.
  });

  const poller = new WorkshopPoller<Workshop[]>(async () => {
    await assertWorkshopVersionCompatible(client, log);
    const projectId = await projects.getId();
    return projectId
      ? withProjectRetry(projects, (id) => listProjectWorkshops(client, id))
      : [];
  });

  const provider = new WorkshopsTreeProvider(poller, client, log, context.extensionUri);
  const treeView = vscode.window.createTreeView('workshop.workshops', {
    treeDataProvider: provider,
  });
  const workshopCommands = createWorkshopCommands({
    client,
    projects,
    globalState: context.globalState,
    log,
    logsView,
  });

  const mountsDataDeps = { client };
  const mountsActions = createMountsActions({
    client,
    ui: createMountsUi(),
    queue: new WorkshopOperationQueue(),
    log,
  });
  const mountsPanel = new MountsPanelProvider(
    {
      loadData: async (selection): Promise<PanelData> => {
        if ((await projects.getId()) === undefined) {
          return { body: { kind: 'message', text: MSG_NO_WORKSHOPS } };
        }
        return withProjectRetry(projects, (id) => fetchPanelData(mountsDataDeps, id, selection));
      },
      log,
      actions: mountsActions,
      reveal: (path) => {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
      },
    },
    context.extensionUri,
  );

  function updateTreeViewTitle(): void {
    treeView.title = vscode.workspace.name ?? undefined;
  }
  updateTreeViewTitle();

  // The panel follows the workshop selected in the tree — a workshop row or
  // any of its detail children.
  function selectedTreeWorkshop(): string | undefined {
    for (const item of treeView.selection) {
      const name = provider.workshopNameForItem(item);
      if (name !== undefined) {
        return name;
      }
    }
    return undefined;
  }
  mountsPanel.setSelectedWorkshop(selectedTreeWorkshop());

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
    mountsPanel,
    vscode.window.registerWebviewViewProvider(MOUNTS_VIEW_ID, mountsPanel),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateTreeViewTitle();
      projects.invalidate();
      void poller.poll();
    }),
    vscode.window.registerFileDecorationProvider(provider.decorationProvider),
    treeView.onDidChangeSelection(() => {
      // A workshop row or any of its children switches the panel; other
      // selections keep the current workshop shown.
      const name = selectedTreeWorkshop();
      if (name !== undefined) {
        mountsPanel.setSelectedWorkshop(name);
      }
    }),
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
    vscode.commands.registerCommand(
      'workshop.addWorkshop',
      () => workshopCommands.addWorkshop(),
    ),
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
