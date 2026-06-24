import * as vscode from 'vscode';
import { Status } from '../api/workshops';

/**
 * Map a workshop {@link Status} to a themed icon, faithful to the colour and
 * glyph choices of the old webview (`old/src/webviewView.ts`):
 *
 * | Status  | Glyph (old / codicon)            | Colour          |
 * |---------|----------------------------------|-----------------|
 * | Ready   | circle-check / `pass`            | charts.green    |
 * | Waiting | clock / `watch`                  | charts.yellow   |
 * | Error   | circle-x / `error`               | charts.red      |
 * | Stopped | circle / `circle-outline`        | description fg  |
 * | Off     | circle-dashed / `circle-large-outline` | disabled fg |
 * | Pending | spinner / `loading~spin`         | (foreground)    |
 * | Unknown | circle-dashed / `circle-large-outline` | description fg |
 */
export function statusIcon(status: Status): vscode.ThemeIcon {
  switch (status) {
    case 'Ready':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'Waiting':
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.yellow'));
    case 'Error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'Stopped':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
    case 'Off':
      return new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('disabledForeground'));
    case 'Pending':
      return new vscode.ThemeIcon('loading~spin');
    default:
      return new vscode.ThemeIcon(
        'circle-large-outline',
        new vscode.ThemeColor('descriptionForeground'),
      );
  }
}
