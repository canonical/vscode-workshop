import { isChangeConflict, WorkshopClient } from '../api/client';
import { displayKey, makeSlotRef, plugKey, SlotRef } from '../api/connections';
import { fallbackTarget, MountRow, sdkSlotCandidates } from './model';
import { MenuAction } from './protocol';
import { WorkshopOperationQueue } from './queue';

/**
 * Orchestration of the panel's daemon mutations, behind a UI port so it
 * stays vscode-free and testable with plain objects. Every mutation runs
 * through the per-workshop {@link WorkshopOperationQueue}; every cancel
 * path returns with no side effects.
 */

export interface MountsUi {
  showError(message: string): void;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  pickFolder(options: { title: string; openLabel: string }): Promise<string | undefined>;
  confirmModal(message: string, detail: string, confirmLabel: string): Promise<boolean>;
  pickSlot(title: string, items: string[]): Promise<string | undefined>;
}

export type MountsActionClient = Pick<
  WorkshopClient,
  'connectionsAction' | 'remountPlug' | 'getConnections'
>;

export interface MountsActionsDeps {
  client: MountsActionClient;
  ui: MountsUi;
  queue: WorkshopOperationQueue;
  log: { info(message: string): void; error(message: string): void };
}

export function createMountsActions(deps: MountsActionsDeps): {
  toggle(row: MountRow, desired: boolean): Promise<void>;
  menu(row: MountRow, action: MenuAction): Promise<void>;
} {
  const { client, ui, queue } = deps;

  function fail(operation: string, err: unknown): never {
    const detail = err instanceof Error ? err.message : String(err);
    ui.showError(`${operation} failed: ${detail}`);
    deps.log.error(`${operation} failed: ${detail}`);
    throw err instanceof Error ? err : new Error(detail);
  }

  /**
   * Connect or disconnect exactly the row's shown pairing. Instant — no
   * progress: the switch is a live control.
   */
  async function toggle(row: MountRow, desired: boolean): Promise<void> {
    const projectId = row.plug['project-id'];
    const workshop = row.plug.workshop;
    if (!desired) {
      try {
        await queue.run(projectId, workshop, () =>
          client.connectionsAction('disconnect', row.plug, row.slot));
      } catch (err) {
        fail('Disconnect', err);
      }
      return;
    }

    try {
      await queue.run(projectId, workshop, () =>
        client.connectionsAction('connect', row.plug, row.slot));
      return;
    } catch (err) {
      // change-conflict (a change started outside the panel — the panel's
      // own operations are queued) takes the plain failure path: no modal,
      // no auto-retry.
      if (isChangeConflict(err)) {
        fail('Connect', err);
      }
      await offerFallback(row, err);
    }
  }

  /**
   * The shown pairing couldn't be established: offer the host, unless the
   * host itself is the pairing that just failed (nothing different to offer,
   * so the plain failure path). Always ends the burst by (re)throwing once
   * the modal resolves.
   */
  async function offerFallback(row: MountRow, cause: unknown): Promise<never> {
    const projectId = row.plug['project-id'];
    const workshop = row.plug.workshop;
    const target = fallbackTarget(row.slot, row.plug);
    if (target === undefined) {
      fail('Connect', cause);
    }

    const detailText = cause instanceof Error ? cause.message : String(cause);
    const confirmed = await ui.confirmModal(
      `Can't establish the connection. Would you like to connect ${displayKey(row.plug)} to ${displayKey(target)} instead?`,
      detailText,
      'Connect',
    );
    if (confirmed) {
      try {
        await queue.run(projectId, workshop, () =>
          client.connectionsAction('connect', row.plug, target));
      } catch (err) {
        fail('Connect', err);
      }
    }
    // The failure (and its modal) ends the burst either way; the switch
    // settles to the daemon's actual state on the next poll.
    throw cause instanceof Error ? cause : new Error(detailText);
  }

  /** Remount a connected host mount onto a chosen host directory. */
  async function remount(row: MountRow): Promise<void> {
    const projectId = row.plug['project-id'];
    const workshop = row.plug.workshop;
    const key = displayKey(row.plug);
    const folder = await ui.pickFolder({
      title: `Remount ${key}`,
      openLabel: 'Remount here',
    });
    if (folder === undefined) {
      return; // cancel changes nothing
    }

    try {
      await ui.withProgress(`Remounting ${key}`, () =>
        queue.run(projectId, workshop, () =>
          client.remountPlug(projectId, workshop, row.plug, folder)));
    } catch (err) {
      fail('Remount', err);
    }
  }

  /** Wire the plug to an SDK-provided mount slot. */
  async function connectToSdk(row: MountRow): Promise<void> {
    const projectId = row.plug['project-id'];
    const workshop = row.plug.workshop;
    const key = plugKey(row.plug);
    const label = displayKey(row.plug);
    let candidates;
    try {
      const snapshot = await client.getConnections(projectId, workshop);
      // A plug and slot must share an interface to be connectable; the plug's
      // interface comes from its snapshot entry.
      const iface = snapshot.plugs.find((plug) => plugKey(plug) === key)?.interface;
      candidates = sdkSlotCandidates(snapshot, iface);
    } catch (err) {
      fail('Connect to SDK', err);
    }
    if (candidates.length === 0) {
      return;
    }

    let target: SlotRef;
    if (candidates.length === 1) {
      target = candidates[0];
    } else {
      const picked = await ui.pickSlot(
        `Connect ${label} to…`,
        candidates.map((slot) => displayKey(slot)),
      );
      if (picked === undefined) {
        return; // cancel changes nothing
      }
      const found = candidates.find((slot) => displayKey(slot) === picked);
      if (found === undefined) {
        return;
      }
      target = found;
    }

    // Strip SlotInfo extras (attrs, connections) down to a wire-shaped ref.
    const chosen = makeSlotRef(target['project-id'], target.workshop, target.sdk, target.slot);
    try {
      await ui.withProgress(`Connecting ${label} to ${displayKey(chosen)}`, () =>
        queue.run(projectId, workshop, () =>
          client.connectionsAction('connect', row.plug, chosen)));
    } catch (err) {
      fail('Connect to SDK', err);
    }
  }

  return {
    toggle,
    menu: (row, action) => (action === 'remount' ? remount(row) : connectToSdk(row)),
  };
}
