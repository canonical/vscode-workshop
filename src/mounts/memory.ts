import {
  attrString,
  ConnectionsSnapshot,
  isHostSlot,
  makeSlotRef,
  plugKey,
  SlotRef,
  SYSTEM_SDK,
} from '../api/connections';
import { isDeepStrictEqual } from 'node:util';

/**
 * Mount wiring memory — the ONE piece of daemon-derived state this extension
 * persists across sessions (sanctioned exception to the stateless-client
 * rule). It is what lets a disconnected row keep its pairing identity
 * (remembered → host) and keep showing its last host path.
 *
 * Key scheme and invalidation contract: each workshop's wirings live under
 * their own globalState key, `workshop.mountWirings/<projectId>/<workshop>`
 * — never one blob for all projects, so concurrent VS Code windows on
 * different projects can't overwrite each other's entries. A workshop's key
 * is *deleted* (not emptied) by {@link clearWorkshopMemory} on Turn Off /
 * delete, and by {@link pruneMemory} when the workshop's container no longer
 * exists. Keys embed a project id, which is not stable across e.g. re-clones
 * — keys under a dead project id are harmless leftovers (nothing reads
 * them) and are not enumerable back to a path, so they are simply left
 * behind.
 *
 * No vscode imports: storage is any Memento-shaped object.
 */

/** The subset of `vscode.Memento` this module needs; `keys` powers pruning. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

/** One remembered wiring channel of a plug. */
export interface RememberedChannel {
  /** The slot the plug was last wired to on this channel. */
  slot: SlotRef;
  /**
   * The last observed source path: the host path (host channel — the daemon
   * only reports it while the mount is established, so it is captured here
   * to survive a disconnect) or the path inside the providing SDK.
   */
  source?: string;
}

/**
 * A plug's remembered wirings, one per channel. Per-channel memory is what
 * makes dual wiring work: a plug wired to the host *and* an SDK keeps two
 * independent identities, and disconnecting one never disturbs the other.
 */
export interface RememberedWiring {
  sdk?: RememberedChannel;
  host?: RememberedChannel;
}

/** All remembered wirings of one workshop, keyed by `<sdk>:<plug>`. */
export type WorkshopMemory = Record<string, RememberedWiring>;

/**
 * Build a channel, omitting `source` when it is unknown. Never store an
 * explicit `undefined` source: it would round-trip through globalState as an
 * absent key, so the change check ({@link isDeepStrictEqual}) would then see
 * every poll as a difference and rewrite the key needlessly.
 */
function rememberedChannel(slot: SlotRef, source: string | undefined): RememberedChannel {
  return source === undefined ? { slot } : { slot, source };
}

const KEY_PREFIX = 'workshop.mountWirings/';

/** The globalState key holding one workshop's wirings. */
export function memoryKey(projectId: string, workshop: string): string {
  return `${KEY_PREFIX}${projectId}/${workshop}`;
}

/** Read a workshop's remembered wirings ({} when nothing is stored). */
export function readWorkshopMemory(
  memento: MementoLike,
  projectId: string,
  workshop: string,
): WorkshopMemory {
  return memento.get<WorkshopMemory>(memoryKey(projectId, workshop)) ?? {};
}

/**
 * Fold the live daemon state into the workshop's memory — called on every
 * poll, so pairings made outside the extension (CLI connects) are
 * remembered like any other. Both `established` and `undesired` entries
 * count: an undesired pairing is a disconnected-with-identity the daemon
 * still reports, and its identity must survive even if the daemon later
 * drops it.
 *
 * `hostSources` maps `<sdk>:<plug>` to the `host-source` reported by the
 * workshop detail's `sdks[].mounts` — the authoritative host path,
 * including the daemon-derived auto path. It exists only while a mount is
 * established, so it is captured here into the host channel; once captured,
 * a missing current path never blanks the remembered one.
 *
 * The key is written only when the folded memory actually differs.
 */
export async function rememberLivePairings(
  memento: MementoLike,
  projectId: string,
  workshop: string,
  snapshot: ConnectionsSnapshot,
  hostSources: Record<string, string> = {},
): Promise<WorkshopMemory> {
  const previous = readWorkshopMemory(memento, projectId, workshop);
  const memory: WorkshopMemory = structuredClone(previous);

  for (const entry of [...snapshot.established, ...snapshot.undesired]) {
    const key = plugKey(entry.plug);
    const wiring = (memory[key] ??= {});
    if (isHostSlot(entry.slot)) {
      wiring.host = rememberedChannel(
        entry.slot,
        hostSources[key]
          ?? attrString(entry['slot-attrs'], 'host-source')
          ?? wiring.host?.source,
      );
    } else {
      wiring.sdk = rememberedChannel(
        entry.slot,
        attrString(entry['slot-attrs'], 'workshop-source') ?? wiring.sdk?.source,
      );
    }
  }

  // A host source observed in the detail without a matching connection entry
  // still updates (or seeds) the host channel — host mounts always pair with
  // the workshop's own system mount slot.
  for (const [key, source] of Object.entries(hostSources)) {
    const wiring = (memory[key] ??= {});
    wiring.host = rememberedChannel(
      wiring.host?.slot ?? makeSlotRef(projectId, workshop, SYSTEM_SDK, 'mount'),
      source,
    );
  }

  if (!isDeepStrictEqual(memory, previous)) {
    await memento.update(memoryKey(projectId, workshop), memory);
  }
  return memory;
}

/** Remember one channel's pairing after a successful panel action. */
export async function rememberPairing(
  memento: MementoLike,
  projectId: string,
  workshop: string,
  key: string,
  channel: keyof RememberedWiring,
  remembered: RememberedChannel,
): Promise<void> {
  const memory = structuredClone(readWorkshopMemory(memento, projectId, workshop));
  const wiring = (memory[key] ??= {});
  wiring[channel] = remembered;
  await memento.update(memoryKey(projectId, workshop), memory);
}

/**
 * Forget a workshop's wirings: the key is deleted outright. Only Turn Off
 * and delete — container removal — go through here; a merely stopped
 * workshop keeps its memory.
 */
export async function clearWorkshopMemory(
  memento: MementoLike,
  projectId: string,
  workshop: string,
): Promise<void> {
  await memento.update(memoryKey(projectId, workshop), undefined);
}

/**
 * Drop the keys of this project's workshops whose container no longer
 * exists. `builtWorkshops` must be the names for which `isBuilt` holds —
 * container existence, NOT the display status: the display collapses raw
 * `stopped` into `Off`, and pruning on that would wipe memory during a
 * guided remount's stop window or a CLI `workshop stop`, which only Turn
 * Off / delete may do.
 */
export async function pruneMemory(
  memento: MementoLike,
  projectId: string,
  builtWorkshops: readonly string[],
): Promise<void> {
  const prefix = `${KEY_PREFIX}${projectId}/`;
  const keep = new Set(builtWorkshops.map((name) => `${prefix}${name}`));
  for (const key of memento.keys()) {
    if (key.startsWith(prefix) && !keep.has(key)) {
      await memento.update(key, undefined);
    }
  }
}
