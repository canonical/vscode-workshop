import * as vscode from 'vscode';
import { WorkshopClient, WorkshopUnavailableError } from '../api/client';
import { statusIcon } from './statusIcon';
import { listProjectWorkshops, Workshop } from '../api/workshops';

/** Context key toggled to drive the view's welcome content (see package.json). */
export const AVAILABLE_CONTEXT = 'workshop.available';

/** A single workshop row in the tree. */
class WorkshopItem extends vscode.TreeItem {
  constructor(workshop: Workshop) {
    super(workshop.name, vscode.TreeItemCollapsibleState.None);
    this.description = workshop.status;
    this.iconPath = statusIcon(workshop.status);
    this.contextValue = 'workshop';
  }
}

/**
 * Lists the workshops of the workspace's first folder, querying the daemon
 * through {@link WorkshopClient}.
 */
export class WorkshopsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly client: WorkshopClient) { }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      await this.setAvailable(true);
      return [];
    }
    try {
      const workshops = await listProjectWorkshops(this.client, folder.uri.fsPath);
      await this.setAvailable(true);
      return workshops.map((w) => new WorkshopItem(w));
    } catch (err) {
      if (err instanceof WorkshopUnavailableError) {
        // Returning no items lets the `viewsWelcome` content render instead.
        await this.setAvailable(false);
        return [];
      }
      throw err;
    }
  }

  private setAvailable(available: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', AVAILABLE_CONTEXT, available);
  }
}
