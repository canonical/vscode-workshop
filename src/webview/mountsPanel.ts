import { PanelData } from '../interfaces/data';
import { MountRow, MountSection } from '../interfaces/model';
import { MSG_DEVICES, MSG_LOADING } from '../interfaces/panelState';
import { ExtToWebview, MenuAction, WebviewToExt } from '../interfaces/protocol';

/**
 * The mounts webview script: a dumb renderer over the provider-pushed
 * {@link PanelData}, plus the purely client-side bits — tab switching, the
 * shared context menu, and the live-switch optimistic overlay.
 *
 * All user-derived text is set via `textContent`; `innerHTML` is used only
 * for three hard-coded SVG glyphs. Bundled by esbuild (iife, browser) into
 * `media/mountsPanel.js`.
 */

interface VsCodeApi {
  postMessage(message: WebviewToExt): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const DOTS_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';

const MENU_LABELS: Record<MenuAction, string> = {
  remount: 'Remount',
  'connect-to-sdk': 'Connect to SDK',
};

const EM_DASH = '—';

let state: PanelData | undefined;
let activeTab = 'mounts';
/** Optimistic switch positions by row id while a toggle burst is in flight. */
const overlay = new Map<string, boolean>();
/** Rows with a toggle burst awaiting its final actionResult. */
const awaiting = new Set<string>();

const content = document.getElementById('content') as HTMLElement;
const menuEl = document.getElementById('ctxmenu') as HTMLElement;
const tabs = [...document.querySelectorAll<HTMLElement>('.tab')];

window.addEventListener('message', (event: MessageEvent<ExtToWebview>) => {
  const message = event.data;
  if (message.type === 'state') {
    state = message.state;
    // Drop overlay entries whose burst has settled; keep the ones still
    // awaiting a result — the polls a burst itself triggers must not
    // visibly revert the switch mid-flight.
    for (const rowId of [...overlay.keys()]) {
      if (!awaiting.has(rowId)) {
        overlay.delete(rowId);
      }
    }
    render();
  } else if (message.type === 'actionResult') {
    awaiting.delete(message.rowId);
    overlay.delete(message.rowId);
    render();
  }
});

for (const tab of tabs) {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab ?? 'mounts'));
  tab.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      switchTab(next.dataset.tab ?? 'mounts');
      next.focus();
      event.preventDefault();
    }
  });
}

function switchTab(tab: string): void {
  activeTab = tab;
  for (const el of tabs) {
    const active = el.dataset.tab === tab;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
    el.tabIndex = active ? 0 : -1;
  }
  render();
}

function render(): void {
  closeMenu();
  content.replaceChildren();
  if (activeTab === 'devices') {
    content.appendChild(emptyMessage(MSG_DEVICES));
    return;
  }
  if (state === undefined) {
    // Before the first state: Loading, never a blank tab.
    content.appendChild(emptyMessage(MSG_LOADING));
    return;
  }
  if (state.body.kind === 'message') {
    content.appendChild(emptyMessage(state.body.text));
    return;
  }
  for (const section of state.body.sections) {
    content.appendChild(renderSection(section));
  }
}

function emptyMessage(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  return el;
}

function renderSection(section: MountSection): HTMLElement {
  const wrap = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'section-title';
  const label = document.createElement('span');
  label.className = 'acc-label';
  label.textContent = section.title;
  title.appendChild(label);
  wrap.appendChild(title);

  const table = document.createElement('div');
  table.className = 'card-table mounts';

  const head = document.createElement('div');
  head.className = 'thead';
  for (const header of [section.sourceHeader, 'Workshop Target', 'Status', '']) {
    const cell = document.createElement('div');
    cell.className = 'cell th';
    cell.textContent = header;
    head.appendChild(cell);
  }
  table.appendChild(head);

  for (const row of section.rows) {
    table.appendChild(renderRow(row));
  }
  wrap.appendChild(table);
  return wrap;
}

function renderRow(row: MountRow): HTMLElement {
  const el = document.createElement('div');
  el.className = 'trow';
  el.tabIndex = 0;
  el.dataset.rowId = row.id;
  el.appendChild(renderSourceCell(row));
  el.appendChild(renderValueCell(row.target, row.targetSub));
  el.appendChild(renderStatusCell(row));
  el.appendChild(renderActionsCell(row));
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (row.menu.length > 0) {
      openMenu(row, event.clientX, event.clientY, el);
    }
  });
  return el;
}

function renderSourceCell(row: MountRow): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const value = document.createElement('div');
  if (row.source === undefined) {
    value.className = 'val dash';
    value.textContent = EM_DASH;
  } else if (row.section === 'host') {
    value.className = 'val mono';
    const link = document.createElement('a');
    link.className = 'link';
    link.tabIndex = 0;
    link.textContent = row.sourceDisplay ?? row.source;
    link.title = row.source;
    const source = row.source;
    const reveal = () => vscode.postMessage({ type: 'reveal', path: source });
    link.addEventListener('click', reveal);
    link.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    value.appendChild(link);
  } else {
    value.className = 'val mono';
    value.textContent = row.source;
  }
  cell.appendChild(value);
  cell.appendChild(subLabel(row.sourceSub));
  return cell;
}

function renderValueCell(value: string | undefined, sub: string): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const val = document.createElement('div');
  val.className = value === undefined ? 'val dash' : 'val mono';
  val.textContent = value ?? EM_DASH;
  cell.appendChild(val);
  cell.appendChild(subLabel(sub));
  return cell;
}

function subLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sub mono';
  el.textContent = text;
  return el;
}

function renderStatusCell(row: MountRow): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'cell statusc';
  const shown = overlay.get(row.id) ?? row.connected;
  const button = document.createElement('button');
  button.className = 'switch';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(shown));
  button.setAttribute('aria-label', shown ? 'Connected' : 'Disconnected');
  const thumb = document.createElement('span');
  thumb.className = 'switch-thumb';
  thumb.innerHTML = shown ? CHECK_SVG : CROSS_SVG;
  button.appendChild(thumb);
  button.addEventListener('click', () => onToggle(row));
  cell.appendChild(button);
  return cell;
}

/**
 * The live switch: every click flips the shown position instantly and posts
 * the new desired position; the provider converges the daemon to the most
 * recent one and settles the burst with a single actionResult.
 */
function onToggle(row: MountRow): void {
  const desired = !(overlay.get(row.id) ?? row.connected);
  overlay.set(row.id, desired);
  awaiting.add(row.id);
  vscode.postMessage({ type: 'toggle', rowId: row.id, desired });
  render();
}

function renderActionsCell(row: MountRow): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'cell actc';
  if (row.menu.length === 0) {
    return cell;
  }
  const button = document.createElement('button');
  button.className = 'act';
  button.setAttribute('aria-label', 'Row actions');
  button.setAttribute('aria-haspopup', 'menu');
  button.innerHTML = DOTS_SVG;
  button.addEventListener('click', () => {
    const rect = button.getBoundingClientRect();
    openMenu(row, rect.left, rect.bottom + 2, button);
  });
  cell.appendChild(button);
  return cell;
}

/** The element to refocus when the menu closes via keyboard. */
let menuAnchor: HTMLElement | undefined;

function openMenu(row: MountRow, x: number, y: number, anchor: HTMLElement): void {
  menuAnchor = anchor;
  menuEl.replaceChildren();
  for (const action of row.menu) {
    const item = document.createElement('div');
    item.className = 'mi';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.textContent = MENU_LABELS[action];
    item.addEventListener('click', () => onMenuAction(row, action));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onMenuAction(row, action);
      }
    });
    menuEl.appendChild(item);
  }
  menuEl.classList.add('show');
  const rect = menuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top = Math.min(y, window.innerHeight - rect.height - 4);
  menuEl.style.left = `${Math.max(0, left)}px`;
  menuEl.style.top = `${Math.max(0, top)}px`;
  (menuEl.firstElementChild as HTMLElement | null)?.focus();
}

function onMenuAction(row: MountRow, action: MenuAction): void {
  closeMenu(true);
  vscode.postMessage({ type: 'menu', rowId: row.id, action });
}

function closeMenu(refocus = false): void {
  if (!menuEl.classList.contains('show')) {
    return;
  }
  menuEl.classList.remove('show');
  if (refocus) {
    menuAnchor?.focus();
  }
  menuAnchor = undefined;
}

menuEl.addEventListener('keydown', (event) => {
  const items = [...menuEl.querySelectorAll<HTMLElement>('.mi')];
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === 'Escape') {
    closeMenu(true);
    event.preventDefault();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : items.length - 1;
    items[(Math.max(current, 0) + step) % items.length]?.focus();
    event.preventDefault();
  } else if (event.key === 'Home') {
    items[0]?.focus();
    event.preventDefault();
  } else if (event.key === 'End') {
    items[items.length - 1]?.focus();
    event.preventDefault();
  } else if (event.key === 'Tab') {
    closeMenu();
  }
});

window.addEventListener('mousedown', (event) => {
  if (!menuEl.contains(event.target as Node)) {
    closeMenu();
  }
});
window.addEventListener('scroll', () => closeMenu(), true);
window.addEventListener('blur', () => closeMenu());

switchTab('mounts');
vscode.postMessage({ type: 'ready' });
