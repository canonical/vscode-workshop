import * as vscode from 'vscode';

import { MountsUi } from '../interfaces/actions';

/** The vscode implementation of the actions layer's UI port. */
export function createMountsUi(): MountsUi {
  return {
    showError(message) {
      void vscode.window.showErrorMessage(message);
    },

    async withProgress(title, task) {
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        task,
      );
    },

    async pickFolder(options) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title: options.title,
        openLabel: options.openLabel,
      });
      return picked?.[0]?.fsPath;
    },

    async confirmModal(message, detail, confirmLabel) {
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        confirmLabel,
      );
      return choice === confirmLabel;
    },

    async pickSlot(title, items) {
      return vscode.window.showQuickPick(items, { title });
    },
  };
}
