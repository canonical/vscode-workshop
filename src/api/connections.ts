/**
 * Wire types and normalization for the daemon's connections API
 * (`/v1/connections`, interface `mount`). Kebab-case keys are quoted because
 * these types are wire-shaped: a `PlugRef`/`SlotRef` serializes verbatim as
 * a request-body entry (the daemon's `plugJSON`/`slotJSON` name their ref
 * fields `plug`/`slot` too), so no to-wire mappers are needed.
 *
 * This module is the one choke point for wire-shape assumptions about
 * connections: everything the extension learns from `GET /v1/connections`
 * passes through {@link normalizeConnections}. No `vscode` imports here.
 */

/** The implicit SDK providing host resources (upstream `sdk.System`). */
export const SYSTEM_SDK = 'system';

/** Reference to a plug, exactly as the daemon sends and accepts it. */
export interface PlugRef {
  'project-id': string;
  workshop: string;
  sdk: string;
  plug: string;
}

/** Reference to a slot, exactly as the daemon sends and accepts it. */
export interface SlotRef {
  'project-id': string;
  workshop: string;
  sdk: string;
  slot: string;
}

/** Interface attributes: static and dynamic merged by the daemon. */
export type ConnAttrs = Record<string, unknown>;

/** One connection (established or undesired) as reported by the daemon. */
export interface ConnectionEntry {
  plug: PlugRef;
  slot: SlotRef;
  interface?: string;
  manual?: boolean;
  'plug-attrs'?: ConnAttrs;
  'slot-attrs'?: ConnAttrs;
}

/** A plug as listed in the snapshot's `plugs` array (`select=all`). */
export interface PlugInfo {
  'project-id': string;
  workshop: string;
  sdk: string;
  plug: string;
  interface?: string;
  attrs?: ConnAttrs;
  label?: string;
  /** A bound plug delegates to another plug; tolerated, not interpreted. */
  bind?: PlugRef;
  connections?: SlotRef[];
}

/** A slot as listed in the snapshot's `slots` array (`select=all`). */
export interface SlotInfo {
  'project-id': string;
  workshop: string;
  sdk: string;
  slot: string;
  interface?: string;
  attrs?: ConnAttrs;
  label?: string;
  connections?: PlugRef[];
}

/** A `GET /v1/connections` result with every array present. */
export interface ConnectionsSnapshot {
  established: ConnectionEntry[];
  undesired: ConnectionEntry[];
  plugs: PlugInfo[];
  slots: SlotInfo[];
}

/**
 * Normalize a raw `GET /v1/connections` result into a
 * {@link ConnectionsSnapshot}: missing arrays become empty (the daemon sends
 * `undesired` with `omitempty`), and malformed entries — ones without a
 * complete plug/slot reference — are dropped rather than crashing the
 * caller. Unknown extra fields (e.g. plug `bind`, attr keys like `mode`,
 * `uid`, `gid`, `read-only`) are preserved as-is.
 */
export function normalizeConnections(raw: unknown): ConnectionsSnapshot {
  const record = isRecord(raw) ? raw : {};
  return {
    established: normalizeArray(record.established, normalizeEntry),
    undesired: normalizeArray(record.undesired, normalizeEntry),
    plugs: normalizeArray(record.plugs, normalizePlugInfo),
    slots: normalizeArray(record.slots, normalizeSlotInfo),
  };
}

function normalizeArray<T>(raw: unknown, one: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(one).filter((item): item is T => item !== undefined);
}

function normalizeEntry(item: unknown): ConnectionEntry | undefined {
  if (!isRecord(item) || !isPlugRef(item.plug) || !isSlotRef(item.slot)) {
    return undefined;
  }
  return item as unknown as ConnectionEntry;
}

function normalizePlugInfo(item: unknown): PlugInfo | undefined {
  return isPlugRef(item) ? (item as unknown as PlugInfo) : undefined;
}

function normalizeSlotInfo(item: unknown): SlotInfo | undefined {
  return isSlotRef(item) ? (item as unknown as SlotInfo) : undefined;
}

function isPlugRef(value: unknown): value is PlugRef {
  return isRecord(value)
    && typeof value['project-id'] === 'string'
    && typeof value.workshop === 'string'
    && typeof value.sdk === 'string'
    && typeof value.plug === 'string';
}

function isSlotRef(value: unknown): value is SlotRef {
  return isRecord(value)
    && typeof value['project-id'] === 'string'
    && typeof value.workshop === 'string'
    && typeof value.sdk === 'string'
    && typeof value.slot === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a slot is provided by the host (`system` SDK). */
export function isHostSlot(slot: SlotRef | SlotInfo): boolean {
  return slot.sdk === SYSTEM_SDK;
}

/** Stable per-workshop channel key for a plug: `<sdk>:<plug>`. */
export function plugKey(ref: Pick<PlugRef, 'sdk' | 'plug'>): string {
  return `${ref.sdk}:${ref.plug}`;
}

/** Stable per-workshop key for a slot: `<sdk>:<slot>`. */
export function slotKey(ref: Pick<SlotRef, 'sdk' | 'slot'>): string {
  return `${ref.sdk}:${ref.slot}`;
}

/** Read a string-valued attribute, or `undefined` when absent/not a string. */
export function attrString(attrs: ConnAttrs | undefined, key: string): string | undefined {
  const value = attrs?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function makeSlotRef(
  projectId: string,
  workshop: string,
  sdk: string,
  slot: string,
): SlotRef {
  return { 'project-id': projectId, workshop, sdk, slot };
}
