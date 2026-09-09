import {
  attrString,
  ConnectionEntry,
  ConnectionsSnapshot,
  isHostSlot,
  makeSlotRef,
  PlugRef,
  plugKey,
  SlotInfo,
  SlotRef,
  slotKey,
  SYSTEM_SDK,
} from '../api/connections';

/**
 * Pure view-model for the Mounts table: turns one poll's daemon state into
 * renderable sections and rows. No vscode imports.
 */

/** One row of the Mounts table — one *wiring* of a plug. */
export interface MountRow {
  /**
   * Stable identity of the pairing+channel (`<section>|<plugKey>|<slotKey>`)
   * — keys optimistic switch state and in-flight actions across re-renders.
   */
  id: string;
  section: 'workshop' | 'host';
  plug: PlugRef;
  /** The slot this row's toggle would (re)connect: its pairing identity. */
  slot: SlotRef;
  connected: boolean;
  /** Full source value — host path or in-SDK path; tooltip and reveal use it. */
  source?: string;
  /** Display-shortened host path, when shortening applies. */
  sourceDisplay?: string;
  /** Sub-label under Source: `<sdk>:<slot>` of the providing slot. */
  sourceSub: string;
  /** The mount's path inside the consuming SDK. */
  target?: string;
  /** Sub-label under Target: `<sdk>:<plug>` of the row's plug. */
  targetSub: string;
  menu: ('remount' | 'connect-to-sdk')[];
  /** True while this row is being remounted — renders the switch disabled. */
  pending: boolean;
}

export interface MountSection {
  id: 'workshop' | 'host';
  title: string;
  sourceHeader: string;
  rows: MountRow[];
}

/** Host mounts from the workshop detail's `sdks[].mounts`, by plug key. */
export type HostMounts = Record<string, { hostSource?: string; workshopTarget?: string }>;

export interface BuildSectionsInput {
  projectId: string;
  workshop: string;
  snapshot: ConnectionsSnapshot;
  /**
   * From the workshop detail — authoritative for host paths, including the
   * daemon-derived auto path (established mounts only).
   */
  mounts: HostMounts;
  /** Row ids currently pending (being remounted). */
  pendingRowIds: ReadonlySet<string>;
}

/**
 * Build the table sections. One row per *wiring*: a plug wired to the host
 * and to an SDK slot (each live, or disconnected-with-identity the daemon
 * still reports as `undesired`) yields two rows, one per section, each with
 * its own toggle. A plug with no identity at all is a disconnected host row.
 * Sections with no rows are omitted; rows sort by SDK name then plug name.
 */
export function buildSections(input: BuildSectionsInput): MountSection[] {
  const { snapshot } = input;
  const candidates = sdkSlotCandidates(snapshot);
  const workshopRows: MountRow[] = [];
  const hostRows: MountRow[] = [];

  const sortedPlugs = [...snapshot.plugs].sort(
    (a, b) => a.sdk.localeCompare(b.sdk) || a.plug.localeCompare(b.plug),
  );

  for (const plugInfo of sortedPlugs) {
    const key = plugKey(plugInfo);
    const plug: PlugRef = {
      'project-id': plugInfo['project-id'],
      workshop: plugInfo.workshop,
      sdk: plugInfo.sdk,
      plug: plugInfo.plug,
    };

    const establishedFor = (host: boolean): ConnectionEntry | undefined =>
      snapshot.established.find((e) => plugKey(e.plug) === key && isHostSlot(e.slot) === host);
    const undesiredFor = (host: boolean): ConnectionEntry | undefined =>
      snapshot.undesired.find((e) => plugKey(e.plug) === key && isHostSlot(e.slot) === host);

    // SDK (Workshop-section) channel: live → disconnected-with-identity.
    const sdkLive = establishedFor(false);
    const sdkUndesired = undesiredFor(false);
    const sdkSlot = sdkLive?.slot ?? sdkUndesired?.slot;

    // Host channel: live → disconnected-with-identity → default (a plug with
    // no other identity is a host row).
    const hostLive = establishedFor(true);
    const hostUndesired = undesiredFor(true);
    const hostSlot = hostLive?.slot
      ?? hostUndesired?.slot
      ?? (sdkSlot === undefined
        ? makeSlotRef(input.projectId, input.workshop, SYSTEM_SDK, 'mount')
        : undefined);

    const target = attrString(plugInfo.attrs, 'workshop-target')
      ?? input.mounts[key]?.workshopTarget;

    if (sdkSlot !== undefined) {
      const connected = sdkLive !== undefined;
      const source = attrString(sdkLive?.['slot-attrs'], 'workshop-source')
        ?? attrString(sdkUndesired?.['slot-attrs'], 'workshop-source')
        ?? attrString(findSlot(snapshot, sdkSlot)?.attrs, 'workshop-source');
      workshopRows.push(makeRow(input, {
        section: 'workshop',
        plug,
        slot: sdkSlot,
        connected,
        source,
        sourceDisplay: undefined,
        target,
        menu: connected ? [] : connectToSdkMenu(candidates),
      }));
    }

    if (hostSlot !== undefined) {
      const connected = hostLive !== undefined;
      const source = input.mounts[key]?.hostSource
        ?? attrString(hostLive?.['slot-attrs'], 'host-source')
        ?? attrString(hostUndesired?.['slot-attrs'], 'host-source');
      hostRows.push(makeRow(input, {
        section: 'host',
        plug,
        slot: hostSlot,
        connected,
        source,
        sourceDisplay: source !== undefined ? shortenHostPath(source) : undefined,
        target: attrString(hostLive?.['plug-attrs'], 'workshop-target') ?? target,
        menu: connected
          ? ['remount', ...connectToSdkMenu(candidates)]
          : connectToSdkMenu(candidates),
      }));
    }
  }

  const sections: MountSection[] = [];
  if (workshopRows.length > 0) {
    sections.push({
      id: 'workshop',
      title: 'Workshop',
      sourceHeader: 'Workshop Source',
      rows: workshopRows,
    });
  }
  if (hostRows.length > 0) {
    sections.push({
      id: 'host',
      title: 'Host to Workshop',
      sourceHeader: 'Host Source',
      rows: hostRows,
    });
  }
  return sections;
}

function makeRow(
  input: BuildSectionsInput,
  row: {
    section: 'workshop' | 'host';
    plug: PlugRef;
    slot: SlotRef;
    connected: boolean;
    source?: string;
    sourceDisplay?: string;
    target?: string;
    menu: ('remount' | 'connect-to-sdk')[];
  },
): MountRow {
  const id = rowId(row.section, row.plug, row.slot);
  return {
    id,
    section: row.section,
    plug: row.plug,
    slot: row.slot,
    connected: row.connected,
    source: row.source,
    sourceDisplay: row.sourceDisplay,
    sourceSub: slotKey(row.slot),
    target: row.target,
    targetSub: plugKey(row.plug),
    menu: row.menu,
    pending: input.pendingRowIds.has(id),
  };
}

/** Stable row identity: section, plug channel, and pairing target. */
export function rowId(
  section: 'workshop' | 'host',
  plug: Pick<PlugRef, 'sdk' | 'plug'>,
  slot: Pick<SlotRef, 'sdk' | 'slot'>,
): string {
  return `${section}|${plugKey(plug)}|${slotKey(slot)}`;
}

function connectToSdkMenu(candidates: SlotInfo[]): ('remount' | 'connect-to-sdk')[] {
  return candidates.length > 0 ? ['connect-to-sdk'] : [];
}

function findSlot(snapshot: ConnectionsSnapshot, ref: SlotRef): SlotInfo | undefined {
  const key = slotKey(ref);
  return snapshot.slots.find((slot) => slotKey(slot) === key);
}

/**
 * SDK-provided mount slots a plug could be wired to: every non-`system`
 * slot in the snapshot ("a compatible SDK slot exists = at least one mount
 * slot on a non-system SDK"). Sorted by SDK then slot name.
 */
export function sdkSlotCandidates(snapshot: ConnectionsSnapshot): SlotInfo[] {
  return snapshot.slots
    .filter((slot) => !isHostSlot(slot))
    .sort((a, b) => a.sdk.localeCompare(b.sdk) || a.slot.localeCompare(b.slot));
}

/**
 * The target offered by the "Can't establish the connection" modal after a
 * connect failed: the host, unless the host itself is the pairing that just
 * failed — in which case there is no different target to offer and the modal
 * is skipped (returns undefined).
 */
export function fallbackTarget(
  failed: SlotRef,
  plug: PlugRef,
): SlotRef | undefined {
  const host = makeSlotRef(plug['project-id'], plug.workshop, SYSTEM_SDK, 'mount');
  return slotKey(host) !== slotKey(failed) ? host : undefined;
}

/**
 * Display-shorten a path under the daemon's data dir to `…/<projectId>/…`,
 * from the 8-hex project-id segment onward. Anchored on the preceding `id`
 * segment (the daemon's layout is `<dataDir>/id/<projectId>/<workshop>/…`)
 * so an unrelated user path that merely contains eight hex digits — e.g. a
 * remount target `/backups/86e64b3e/data` — is never mangled. Returns
 * undefined when the path isn't shaped like that.
 */
export function shortenHostPath(path: string): string | undefined {
  const segments = path.split('/');
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === 'id' && /^[0-9a-f]{8}$/.test(segments[i + 1])) {
      return `…/${segments.slice(i + 1).join('/')}`;
    }
  }
  return undefined;
}
