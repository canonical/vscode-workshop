// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { WorkshopsTreeProvider } from './ui/workshopsTree';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const client = new WorkshopClient();
  const provider = new WorkshopsTreeProvider(client);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('workshop.workshops', provider),
    vscode.commands.registerCommand('workshop.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('workshop.install', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://snapcraft.io/workshop')),
    ),
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
