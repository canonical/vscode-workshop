import {
  attrString,
  ConnectionEntry,
  ConnectionsSnapshot,
  displayKey,
  isHostSlot,
  makeSlotRef,
  PlugInfo,
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
  menu: MountMenuItem[];
}

/**
 * A row's context-menu entry: remount (connected host mounts only) or connect
 * the plug to a specific candidate SDK slot (disconnected rows only).
 */
export type MountMenuItem =
  | { kind: 'remount' }
  | { kind: 'connect'; slot: SlotRef };

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
}

/**
 * Build the table sections. A plug is wired to exactly one place at a time,
 * so it gets exactly one row, never one per section: an established
 * connection wins over an `undesired` one (disconnected-with-identity, e.g. a
 * stale "don't reconnect to the host" memory left over from a since-moved
 * plug), which wins over the default disconnected host row for a plug the
 * daemon lists with no connection at all. Rows sort by SDK name then plug
 * name; sections with no rows are omitted.
 */
export function buildSections(input: BuildSectionsInput): MountSection[] {
  const { snapshot } = input;
  const workshopRows: MountRow[] = [];
  const hostRows: MountRow[] = [];
  // Plugs that already have a row; a plug with none becomes a default host
  // row below. Established rows are added first, so they win ties.
  const handledPlugs = new Set<string>();

  const addConnectionRow = (entry: ConnectionEntry, connected: boolean): void => {
    const key = plugKey(entry.plug);
    if (handledPlugs.has(key)) {
      return;
    }
    handledPlugs.add(key);
    // A connect target must share the plug's interface; the row's own
    // current slot is excluded — the switch already handles that pairing.
    const candidates = sdkSlotCandidates(snapshot, entry.plug);
    const target = attrString(entry['plug-attrs'], 'workshop-target')
      ?? attrString(findPlug(snapshot, entry.plug)?.attrs, 'workshop-target')
      ?? input.mounts[key]?.workshopTarget;

    if (isHostSlot(entry.slot)) {
      const source = input.mounts[key]?.hostSource
        ?? attrString(entry['slot-attrs'], 'host-source');
      hostRows.push(makeRow({
        section: 'host',
        plug: entry.plug,
        slot: entry.slot,
        connected,
        source,
        sourceDisplay: source !== undefined ? shortenHostPath(source) : undefined,
        target,
        menu: connected ? [{ kind: 'remount' }] : connectItems(candidates, entry.slot),
      }));
    } else {
      const source = attrString(entry['slot-attrs'], 'workshop-source')
        ?? attrString(findSlot(snapshot, entry.slot)?.attrs, 'workshop-source');
      workshopRows.push(makeRow({
        section: 'workshop',
        plug: entry.plug,
        slot: entry.slot,
        connected,
        source,
        sourceDisplay: undefined,
        target,
        menu: connected ? [] : connectItems(candidates, entry.slot),
      }));
    }
  };

  for (const entry of snapshot.established) {
    addConnectionRow(entry, true);
  }
  for (const entry of snapshot.undesired) {
    addConnectionRow(entry, false);
  }

  // A plug with no connection at all is a disconnected host row (its toggle
  // connects to the host).
  for (const plugInfo of snapshot.plugs) {
    const key = plugKey(plugInfo);
    if (handledPlugs.has(key)) {
      continue;
    }
    const candidates = sdkSlotCandidates(snapshot, plugInfo);
    const source = input.mounts[key]?.hostSource;
    const hostSlot = makeSlotRef(input.projectId, input.workshop, SYSTEM_SDK, 'mount');
    hostRows.push(makeRow({
      section: 'host',
      plug: {
        'project-id': plugInfo['project-id'],
        workshop: plugInfo.workshop,
        sdk: plugInfo.sdk,
        plug: plugInfo.plug,
      },
      slot: hostSlot,
      connected: false,
      source,
      sourceDisplay: source !== undefined ? shortenHostPath(source) : undefined,
      target: attrString(plugInfo.attrs, 'workshop-target') ?? input.mounts[key]?.workshopTarget,
      menu: connectItems(candidates, hostSlot),
    }));
  }

  const bySdkThenPlug = (a: MountRow, b: MountRow): number =>
    a.plug.sdk.localeCompare(b.plug.sdk) || a.plug.plug.localeCompare(b.plug.plug);
  workshopRows.sort(bySdkThenPlug);
  hostRows.sort(bySdkThenPlug);

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
  row: {
    section: 'workshop' | 'host';
    plug: PlugRef;
    slot: SlotRef;
    connected: boolean;
    source?: string;
    sourceDisplay?: string;
    target?: string;
    menu: MountMenuItem[];
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
    sourceSub: displayKey(row.slot),
    target: row.target,
    targetSub: displayKey(row.plug),
    menu: row.menu,
  };
}

/** Stable row identity: section, plug channel, and pairing target. */
export function rowId(
  section: 'workshop' | 'host',
  plug: PlugRef,
  slot: SlotRef,
): string {
  return `${section}|${plugKey(plug)}|${slotKey(slot)}`;
}

function connectItems(candidates: SlotInfo[], exclude: SlotRef): MountMenuItem[] {
  const excludeKey = slotKey(exclude);
  return candidates
    .filter((slot) => slotKey(slot) !== excludeKey)
    .map((slot) => ({
      kind: 'connect',
      slot: makeSlotRef(slot['project-id'], slot.workshop, slot.sdk, slot.slot),
    }));
}

function findSlot(snapshot: ConnectionsSnapshot, ref: SlotRef): SlotInfo | undefined {
  const key = slotKey(ref);
  return snapshot.slots.find((slot) => slotKey(slot) === key);
}

function findPlug(snapshot: ConnectionsSnapshot, ref: PlugRef): PlugInfo | undefined {
  const key = plugKey(ref);
  return snapshot.plugs.find((plug) => plugKey(plug) === key);
}

/**
 * Connectable mount slots for `plug`: every slot — including the host — on
 * the plug's interface, minus any slot the plug is already connected to. A
 * plug and slot must share an interface to be connectable. Sorted by SDK then
 * slot name.
 */
export function sdkSlotCandidates(
  snapshot: ConnectionsSnapshot,
  plug: PlugRef,
): SlotInfo[] {
  const info = findPlug(snapshot, plug);
  const connected = new Set((info?.connections ?? []).map(slotKey));
  return snapshot.slots
    .filter((slot) =>
      slot.interface === info?.interface
      && !connected.has(slotKey(slot)))
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
