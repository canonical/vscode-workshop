// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { WorkshopClient } from './api/client';
import { UNAVAILABLE_CONTEXT, WorkshopsTreeProvider } from './ui/workshopsTree';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Workshop', { log: true });
  const client = new WorkshopClient();
  log.info(`Workshop extension activated; using daemon socket ${client.socket}`);
  const provider = new WorkshopsTreeProvider(client, log);

  // Start in the "not unavailable" state so the welcome stub stays hidden until
  // a request actually proves the daemon is unreachable. (The unset default
  // already hides it; this just makes the intent explicit.)
  void vscode.commands.executeCommand('setContext', UNAVAILABLE_CONTEXT, false);

  context.subscriptions.push(
    log,
    vscode.window.registerTreeDataProvider('workshop.workshops', provider),
    vscode.commands.registerCommand('workshop.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('workshop.install', () =>
      vscode.env.openExternal(vscode.Uri.parse('https://snapcraft.io/workshop')),
    ),
  );
}

// This method is called when your extension is deactivated
export function deactivate() { }
