import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: ['--no-sandbox', '--ozone-platform=x11'],
});
