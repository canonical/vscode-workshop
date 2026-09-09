import { parse } from 'yaml';

import { SYSTEM_SDK } from '../api/connections';

/**
 * Declared connections from a workshop definition file.
 *
 * The REST API doesn't expose the definition's `connections:` section; the
 * workshop detail only returns the definition file path, so the extension
 * reads the YAML itself. The file lives on this machine because the
 * extension runs with `extensionKind: ["ui"]` — the host is always the
 * daemon's machine.
 *
 * No vscode imports; file access is injected.
 */

/** One `connections:` entry, parsed: `plug: "<sdk>:<name>"` etc. */
export interface DeclaredPairing {
  plug: { sdk: string; name: string };
  slot: { sdk: string; name: string };
}

/**
 * Parse the `connections:` section out of a definition YAML text.
 *
 * Tolerant by design — never throws: malformed YAML, a missing/non-list
 * `connections:`, and entries that aren't `<sdk>:<name>` two-part strings
 * are all skipped. An empty sdk part (`:mount`) means the `system` SDK
 * (upstream `workshop_file.go` defaults it the same way).
 */
export function parseDeclaredConnections(yamlText: string): DeclaredPairing[] {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return [];
  }
  if (!isRecord(doc) || !Array.isArray(doc.connections)) {
    return [];
  }
  const pairings: DeclaredPairing[] = [];
  for (const entry of doc.connections) {
    if (!isRecord(entry)) {
      continue;
    }
    const plug = parseRef(entry.plug);
    const slot = parseRef(entry.slot);
    if (plug && slot) {
      pairings.push({ plug, slot });
    }
  }
  return pairings;
}

function parseRef(raw: unknown): { sdk: string; name: string } | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const parts = raw.split(':');
  if (parts.length !== 2 || parts[1].length === 0) {
    return undefined;
  }
  return { sdk: parts[0].length === 0 ? SYSTEM_SDK : parts[0], name: parts[1] };
}

/**
 * Read a definition file and parse its declared connections. A missing or
 * unreadable file yields `[]` — the feature degrades to "nothing declared".
 * Callers re-read per poll on purpose (no mtime/content cache): the file is
 * tiny and this keeps edits visible without an invalidation path to get
 * wrong.
 */
export async function loadDeclaredConnections(
  definitionPath: string,
  readFile: (filePath: string) => Promise<string>,
): Promise<DeclaredPairing[]> {
  try {
    return parseDeclaredConnections(await readFile(definitionPath));
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
