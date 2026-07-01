import * as vscode from 'vscode';
import { WorkshopClient, WorkshopUnavailableError } from '../api/client';
import { statusIcon } from './statusIcon';
import { listProjectWorkshops, Workshop } from '../api/workshops';

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

  constructor(
    private readonly client: WorkshopClient,
    private readonly log?: vscode.LogOutputChannel,
  ) { }

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
      await this.setUnavailable(false);
      return [];
    }
    // Keep the welcome view hidden while the request is in flight: VS Code shows
    // its built-in tree loading spinner instead, avoiding a blink between the
    // welcome stub and the workshops list. We only flag it unavailable below if
    // the daemon turns out to be genuinely unreachable.
    await this.setUnavailable(false);
    try {
      const workshops = await listProjectWorkshops(this.client, folder.uri.fsPath);
      this.log?.info(`Listed ${workshops.length} workshop(s) for ${folder.uri.fsPath}`);
      return workshops.map((w) => new WorkshopItem(w));
    } catch (err) {
      if (err instanceof WorkshopUnavailableError) {
        // Returning no items lets the `viewsWelcome` content render instead.
        await this.setUnavailable(true);
        this.log?.warn(
          `Workshop daemon unavailable (${err.code ?? 'no code'}): ${err.message}. ` +
          'Showing the welcome view.',
        );
        return [];
      }
      this.log?.error(`Failed to list workshops: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  private setUnavailable(unavailable: boolean): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', UNAVAILABLE_CONTEXT, unavailable);
  }
}
