import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (two levels above this file). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPT_DIR = path.join(ROOT, 'scripts', 'screenshots');
/** Scratch space: downloaded CLI state, extensions dir, user-data dir, packaged .vsix. */
export const WORK_DIR = path.join(SCRIPT_DIR, '.work');
export const USER_DATA_DIR = path.join(WORK_DIR, 'user-data');
export const EXTENSIONS_DIR = path.join(WORK_DIR, 'extensions');
export const VSIX_PATH = path.join(WORK_DIR, 'workshop.vsix');
/** Where the PNGs land; committed to the repo. */
export const OUT_DIR = path.join(ROOT, 'media', 'screenshots');

/** Pinned so that every regeneration renders the same chrome. Bump deliberately. */
export const VSCODE_VERSION = '1.136.2';
export const REMOTE_SSH_VERSION = '0.128.0';
export const VSCODE_CACHE_DIR = path.join(ROOT, '.vscode-test');

/** Sample project the story is told on. Its basename becomes part of the hostname. */
export const SAMPLE_DIR = process.env.SCREENSHOT_SAMPLE_DIR ?? path.join(os.homedir(), 'hello-workshop');
export const WORKSHOP_NAME = 'dev';
/**
 * `<workshop>.<project basename>.wp`, with spaces, dots, and underscores in the
 * basename replaced by `-`; see lxd_backend_dns.go in the daemon.
 */
export const EXPECTED_HOSTNAME = `${WORKSHOP_NAME}.${path.basename(SAMPLE_DIR).replace(/[ ._]/g, '-')}.wp`;
/** SDK added in the "change the definition" step. */
export const EXTRA_SDK = 'uv';
/** In-project SDK whose setup hook fails on purpose, to show a paused refresh. */
export const BROKEN_SDK = 'broken';

export const WINDOW = { width: 1600, height: 1000 };

export const LAUNCH_TIMEOUT_MS = 15 * 60_000;
export const REFRESH_TIMEOUT_MS = 10 * 60_000;
export const UI_TIMEOUT_MS = 30_000;

export const HELLO_GO = `package main

import (
	"fmt"
	"net/http"
	"runtime"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello from %s\\n", runtime.Version())
	})
	fmt.Println("Listening on http://localhost:8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		fmt.Println(err)
	}
}
`;

export const GO_MOD = `module hello

go 1.27
`;
