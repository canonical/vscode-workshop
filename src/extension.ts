import * as vscode from 'vscode';

import { WorkshopClient } from './api/client';
import { listProjectWorkshops, Workshop } from './api/workshops';
import { createMountsActions } from './interfaces/actions';
import { fetchPanelData, PanelData } from './interfaces/data';
import { MSG_NO_WORKSHOPS } from './interfaces/panelState';
import { WorkshopOperationQueue } from './interfaces/queue';
import { WorkshopPoller } from './poller';
import { SELECTED_WORKSHOP_KEY } from './state';
import { assertWorkshopVersionCompatible } from './version';
import { createDefinitionWatcher } from './ui/definitionWatcher';
import { LogsView } from './ui/logsView';
import { createMountsUi } from './ui/mountsUi';
import { PANEL_VIEW_ID, WorkshopPanelProvider } from './ui/workshopPanel';
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
} from './workspaceContext';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);

  void vscode.commands.executeCommand('setContext', VIEW_STATE_CONTEXT, 'ready');

  const logsView = new LogsView();
  logsView.register(context);

  const projects = new ProjectContext(client, context.globalState);

  const poller = new WorkshopPoller<Workshop[]>(async () => {
    await assertWorkshopVersionCompatible(client, log);
    const projectId = await projects.getId();
    return projectId ? listProjectWorkshops(client, projectId) : [];
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
  const workshopPanel = new WorkshopPanelProvider(
    {
      loadData: async (selection): Promise<PanelData> => {
        const projectId = await projects.getId();
        if (projectId === undefined) {
          return { body: { kind: 'message', text: MSG_NO_WORKSHOPS } };
        }
        return fetchPanelData(mountsDataDeps, projectId, selection);
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

  // Only a local window remembers its selection; a workshop window always
  // selects the workshop it is connected to.
  function rememberSelection(name: string | undefined): void {
    if (!isWorkshopWindow()) {
      void context.workspaceState.update(SELECTED_WORKSHOP_KEY, name);
    }
  }

  // The workshop to select in the tree once a poll lists it.
  let restoring = isWorkshopWindow()
    ? currentWorkshop(context.globalState)?.session?.workshopName
    : context.workspaceState.get<string>(SELECTED_WORKSHOP_KEY);
  workshopPanel.setSelectedWorkshop(restoring);

  function restoreSelection(): void {
    if (restoring === undefined || !provider.listed) {
      return;
    }
    const item = provider.workshopItem(restoring);
    if (item === undefined) {
      workshopPanel.setSelectedWorkshop(undefined);
      rememberSelection(undefined);
    } else if (treeView.visible) {
      void treeView.reveal(item, { select: true, focus: false });
    } else {
      return; // reveal would open the closed view
    }
    restoring = undefined;
  }

  let activationHandle: vscode.Disposable | undefined;
  function onViewVisible(): void {
    activationHandle ??= poller.activate();
    const workshopName = currentWorkshop(context.globalState)?.session?.workshopName;
    if (workshopName) {
      provider.setActiveWorkshop(workshopName);
    }
    restoreSelection();
  }

  if (treeView.visible) {
    onViewVisible();
  } else if (restoring !== undefined) {
    // Drop a workshop that is gone even while the tree stays closed.
    void poller.poll();
  }
  if (!isWorkshopWindow()) {
    workshopCommands.activateLocalProject();
  }

  context.subscriptions.push(
    log,
    poller,
    provider,
    treeView,
    workshopPanel,
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, workshopPanel),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateTreeViewTitle();
      projects.invalidate();
      void poller.poll();
    }),
    vscode.window.registerFileDecorationProvider(provider.decorationProvider),
    provider.onDidChangeTreeData(restoreSelection),
    treeView.onDidChangeSelection(() => {
      // A workshop row or any of its children switches the panel; other
      // selections keep the current workshop shown.
      const name = selectedTreeWorkshop();
      if (name !== undefined) {
        rememberSelection(name);
        // Already shown, e.g. restored on activation: leave a closed panel closed.
        if (name === workshopPanel.selectedWorkshop) {
          return;
        }
        workshopPanel.setSelectedWorkshop(name);
        // Surface the panel if it's collapsed/closed; leave it alone (and
        // leave focus on the tree) if it's already showing.
        if (!workshopPanel.visible) {
          void vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`, { preserveFocus: true });
        }
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
