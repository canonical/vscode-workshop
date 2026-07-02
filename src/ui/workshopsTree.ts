import * as vscode from 'vscode';
import { WorkshopUnavailableError } from '../api/client';
import { WorkshopPoller } from '../poller';
import { statusIcon } from './statusIcon';
import { Workshop } from '../api/workshops';

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
export class WorkshopItem extends vscode.TreeItem {
  constructor(readonly workshop: Workshop, connected = false) {
    super(workshop.name, vscode.TreeItemCollapsibleState.None);
    this.description = connected ? `${workshop.status} \u2022 active` : workshop.status;
    this.iconPath = statusIcon(workshop.status);
    if (connected) {
      this.contextValue = 'workshop-connected';
    } else if (workshop.status === 'Pending' || workshop.status === 'Waiting') {
      this.contextValue = 'workshop-pending';
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
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private cachedItems: Workshop[] = [];
  private isUnavailable = false;
  private activeWorkshopName: string | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    poller: WorkshopPoller<Workshop[]>,
    private readonly log?: vscode.LogOutputChannel,
  ) {
    this.subscriptions.push(
      poller.onDidUpdate((workshops) => {
        this.cachedItems = workshops;
        this.isUnavailable = false;
        void this.setUnavailable(false);
        this.log?.info(`Updated ${workshops.length} workshop(s) from poller`);
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
    if (element) {
      return [];
    }
    if (this.isUnavailable) {
      return [];
    }
    return this.cachedItems.map((w) => {
      const connected = w.name === this.activeWorkshopName;
      return new WorkshopItem(w, connected);
    });
  }

  /** Update which workshop the current window is connected to. */
  setActiveWorkshop(name: string | undefined): void {
    this.activeWorkshopName = name;
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
