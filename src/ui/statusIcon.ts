import * as vscode from 'vscode';
import { Status } from '../api/workshops';

/**
 * Map a workshop {@link Status} to a themed icon:
 *
 * | Status  | Glyph (codicon)       | Colour          |
 * |---------|-----------------------|-----------------|
 * | On      | `pass`                | charts.green    |
 * | Waiting | `watch`               | charts.yellow   |
 * | Error   | `error`               | charts.red      |
 * | Off     | `circle-large-outline`| disabled fg     |
 * | Pending | `loading~spin`        | (foreground)    |
 * | Unknown | `circle-large-outline`| description fg  |
 */
export function statusIcon(status: Status): vscode.ThemeIcon {
  switch (status) {
    case 'On':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'Waiting':
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.yellow'));
    case 'Error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
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
