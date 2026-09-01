import * as vscode from 'vscode';

import {
  firstFreeName,
  preferredBase,
  REFERENCE_SDKS,
  ReferenceSdk,
  SDK_CATEGORY_ORDER,
  SUPPORTED_BASES,
  validateWorkshopName,
} from '../api/sdkCatalog';

export interface WizardFolder {
  name: string;
  path: string;
}

export interface WizardResult {
  folder: WizardFolder;
  /** SDK names in the order the user selected them. */
  sdks: string[];
  base: string;
  name: string;
}

export interface WizardDeps {
  /** Workspace folders to choose from; must not be empty. */
  folders: WizardFolder[];
  /** Names of the workshops already defined in a folder (for the name pre-fill). */
  existingNames: (folderPath: string) => Promise<string[]>;
  log: Pick<vscode.LogOutputChannel, 'info' | 'warn' | 'debug'>;
  /** Override for `vscode.env.openExternal` — injected in tests. */
  openExternal?: (url: string) => Thenable<boolean>;
}

export const NO_COMMON_BASE_MESSAGE =
  'The selected SDKs have no base in common. Go back and change the selection.';
export const INVALID_NAME_LABEL = 'Invalid workshop name';

// ---------------------------------------------------------------------------
// Quick Pick items
// ---------------------------------------------------------------------------

export interface FolderPickItem extends vscode.QuickPickItem {
  folder: WizardFolder;
}

export interface SdkPickItem extends vscode.QuickPickItem {
  sdk?: ReferenceSdk;
}

export interface BasePickItem extends vscode.QuickPickItem {
  base?: string;
}

export interface NameActionItem extends vscode.QuickPickItem {
  name?: string;
  valid: boolean;
}

/** Info button that opens an SDK's project page. */
export const SDK_INFO_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('info'),
  tooltip: 'Open the SDK repository',
};

export function folderPickItems(folders: WizardFolder[]): FolderPickItem[] {
  return folders.map((folder) => ({ label: folder.name, description: folder.path, folder }));
}

/** All reference SDKs under a separator per category. */
export function sdkPickItems(): SdkPickItem[] {
  const items: SdkPickItem[] = [];
  for (const category of SDK_CATEGORY_ORDER) {
    const sdks = REFERENCE_SDKS.filter((sdk) => sdk.category === category);
    if (sdks.length === 0) {
      continue;
    }
    items.push({ label: category, kind: vscode.QuickPickItemKind.Separator });
    for (const sdk of sdks) {
      items.push({
        label: sdk.name,
        description: sdk.summary,
        sdk,
        buttons: sdk.repoUrl ? [SDK_INFO_BUTTON] : [],
      });
    }
  }
  return items;
}

/** Base rows, newest first, with the preferred base marked `(default)`. */
export function basePickItems(bases: string[]): BasePickItem[] {
  const preferred = preferredBase(bases);
  return bases.map((base) => ({
    label: base,
    description: base === preferred ? '(default)' : undefined,
    base,
  }));
}

/** The single action row of the name step, for the typed `value`. */
export function nameActionRow(value: string): NameActionItem {
  const name = value.trim();
  const problem = validateWorkshopName(name);
  if (problem) {
    return { label: INVALID_NAME_LABEL, detail: problem, alwaysShow: true, valid: false };
  }
  return { label: `Create workshop ${name}`, alwaysShow: true, valid: true, name };
}

// ---------------------------------------------------------------------------
// Multi-step machinery
// ---------------------------------------------------------------------------

/** The user pressed Back: return to the previous step. */
class BackSignal {}
/** The user dismissed the wizard. */
class CancelSignal {}

interface PickOptions<T extends vscode.QuickPickItem> {
  title: string;
  placeholder: string;
  items: T[];
  activeItems?: T[];
  selectedItems?: T[];
  value?: string;
  canSelectMany?: boolean;
  matchOnDescription?: boolean;
  showBack: boolean;
  /** Attach extra listeners before the picker is shown. */
  configure?: (picker: vscode.QuickPick<T>) => void;
  /** Items to return on accept; `undefined` ignores the accept and keeps the picker open. */
  accept?: (picker: vscode.QuickPick<T>) => T[] | undefined;
}

function showPick<T extends vscode.QuickPickItem>(options: PickOptions<T>): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    picker.ignoreFocusOut = true;
    picker.buttons = options.showBack ? [vscode.QuickInputButtons.Back] : [];
    picker.canSelectMany = options.canSelectMany ?? false;
    picker.matchOnDescription = options.matchOnDescription ?? false;
    picker.items = options.items;
    if (options.value !== undefined) {
      picker.value = options.value;
    }
    if (options.activeItems) {
      picker.activeItems = options.activeItems;
    }
    if (options.selectedItems) {
      picker.selectedItems = options.selectedItems;
    }

    let settled = false;
    const disposables: vscode.Disposable[] = [];
    function finish(outcome: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      outcome();
      picker.hide();
    }

    disposables.push(
      picker.onDidTriggerButton((button) => {
        if (button === vscode.QuickInputButtons.Back) {
          finish(() => reject(new BackSignal()));
        }
      }),
      picker.onDidAccept(() => {
        const picked = options.accept ? options.accept(picker) : [...picker.selectedItems];
        if (picked === undefined) {
          return;
        }
        finish(() => resolve(picked));
      }),
      picker.onDidHide(() => {
        finish(() => reject(new CancelSignal()));
        for (const disposable of disposables) {
          disposable.dispose();
        }
        picker.dispose();
      }),
    );
    options.configure?.(picker);
    picker.show();
  });
}

type StepId = 'folder' | 'sdks' | 'base' | 'name';

interface Frame {
  id: StepId;
  run: (showBack: boolean) => Promise<Frame | 'done' | 'abort'>;
}

interface WizardState {
  folder?: WizardFolder;
  /** In selection order. */
  sdkNames: string[];
  base?: string;
  name?: string;
}

/**
 * Run the Add New Workshop wizard: folder → SDKs → base → name.
 * Resolves `undefined` when the user aborts at any step.
 */
export async function runAddWorkshopWizard(deps: WizardDeps): Promise<WizardResult | undefined> {
  const openExternal = deps.openExternal ?? ((url: string) => vscode.env.openExternal(vscode.Uri.parse(url)));
  const state: WizardState = { sdkNames: [] };

  const folderFrame: Frame = {
    id: 'folder',
    run: async (showBack) => {
      const items = folderPickItems(deps.folders);
      const previous = items.find((item) => item.folder.path === state.folder?.path);
      const [picked] = await showPick({
        title: 'Select a folder',
        placeholder: 'Select a folder in the workspace',
        items,
        activeItems: previous ? [previous] : undefined,
        showBack,
      });
      if (!picked) {
        return 'abort';
      }
      state.folder = picked.folder;
      return sdksFrame;
    },
  };

  const sdksFrame: Frame = {
    id: 'sdks',
    run: async (showBack) => {
      const items = sdkPickItems();
      const selected = state.sdkNames
        .map((name) => items.find((item) => item.sdk?.name === name))
        .filter((item): item is SdkPickItem => item !== undefined);
      let order = [...state.sdkNames];
      const picked = await showPick({
        title: 'Select SDKs',
        placeholder: 'Select SDKs to add to the workshop',
        items,
        selectedItems: selected,
        canSelectMany: true,
        matchOnDescription: true,
        showBack,
        configure: (picker) => {
          picker.onDidChangeSelection((selection) => {
            const names = selection.map((item) => item.sdk?.name).filter((n): n is string => !!n);
            order = [
              ...order.filter((name) => names.includes(name)),
              ...names.filter((name) => !order.includes(name)),
            ];
          });
          picker.onDidTriggerItemButton((event) => {
            const url = event.item.sdk?.repoUrl;
            if (url) {
              void openExternal(url);
            }
          });
        },
      });
      const names = new Set(picked.map((item) => item.sdk?.name).filter((n): n is string => !!n));
      if (names.size === 0) {
        deps.log.debug('Add New Workshop aborted: no SDKs selected');
        return 'abort';
      }
      state.sdkNames = order.filter((name) => names.has(name));
      return baseFrame;
    },
  };

  const baseFrame: Frame = {
    id: 'base',
    run: async (showBack) => {
      const items = basePickItems([...SUPPORTED_BASES]);
      const previous = items.find((item) => item.base === state.base);
      const preferred = items.find((item) => item.base === preferredBase(SUPPORTED_BASES));
      const [picked] = await showPick({
        title: 'Select a base',
        placeholder: 'Select an Ubuntu base for the workshop',
        items,
        activeItems: previous ? [previous] : preferred ? [preferred] : undefined,
        showBack,
      });
      if (!picked?.base) {
        return 'abort';
      }
      state.base = picked.base;
      return nameFrame;
    },
  };

  const nameFrame: Frame = {
    id: 'name',
    run: async (showBack) => {
      const folder = state.folder as WizardFolder;
      const existing = await deps.existingNames(folder.path).catch(() => [] as string[]);
      const value = state.name ?? firstFreeName(existing);
      const [picked] = await showPick<NameActionItem>({
        title: 'Enter a name',
        placeholder: 'Enter a name for the workshop',
        items: [nameActionRow(value)],
        value,
        showBack,
        configure: (picker) => {
          picker.onDidChangeValue((typed) => {
            picker.items = [nameActionRow(typed)];
          });
        },
        accept: (picker) => {
          const row = nameActionRow(picker.value);
          return row.valid ? [row] : undefined;
        },
      });
      if (!picked?.name) {
        return 'abort';
      }
      state.name = picked.name;
      return 'done';
    },
  };

  if (deps.folders.length === 1) {
    state.folder = deps.folders[0];
  }
  const frames: Frame[] = [deps.folders.length === 1 ? sdksFrame : folderFrame];

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    try {
      const next = await frame.run(frames.length > 1);
      if (next === 'abort') {
        return undefined;
      }
      if (next === 'done') {
        break;
      }
      frames.push(next);
    } catch (err: unknown) {
      if (err instanceof CancelSignal) {
        deps.log.debug('Add New Workshop cancelled');
        return undefined;
      }
      if (err instanceof BackSignal) {
        frames.pop();
        continue;
      }
      throw err;
    }
  }
  if (frames.length === 0 || !state.folder || !state.base || !state.name) {
    return undefined;
  }

  return {
    folder: state.folder,
    sdks: state.sdkNames,
    base: state.base,
    name: state.name,
  };
}
