# Screenshot generator

Local-only tooling. The driver sources here are committed, but they are not part
of the extension: `.vscodeignore` leaves `scripts/**` out of the package and the
root `tsconfig.json` excludes it from the build. Gitignored are the scratch
directory `scripts/screenshots/.work/` (extensions dir, user data, packaged
`.vsix`), the VS Code download in `.vscode-test/` at the repo root, and the
`media/screenshots/_failure.png` diagnostic capture. The PNGs the driver renders
into `media/screenshots/` are committed.

The images in `media/screenshots/` (also used by the Workshop documentation) are
generated, never captured by hand, so that they all share the same VS Code
version, theme, and window size. This driver runs a pinned VS Code build with
Playwright through the whole story: create a sample project, add a workshop with
the wizard, reopen in it, change the definition, refresh, break it, and turn it
off.

It runs on the host, not inside the `ext` workshop, because it needs the real
`workshop` daemon, LXD, network access to the SDK store, and an X display. It
needs Node 22.18 or newer (24 works): the driver runs its `.ts` sources directly
through Node's built-in type stripping, so there is no build step.

```bash
npm install                  # once, at the repo root: @vscode/test-electron, tsc, and vsce live there
cd scripts/screenshots
npm install                  # once; playwright-core is declared here, not in the root package.json
npm run screenshots          # on the current X session
npm run screenshots:xvfb     # on a virtual display instead
npm run check                # type-check the driver
```

The first run downloads VS Code into `.vscode-test/` at the repo root, packages
the extension from the working tree with `npx @vscode/vsce`, and installs it
with Remote - SSH into an isolated extensions directory under
`scripts/screenshots/.work/`. It creates `~/hello-workshop` with a `dev`
workshop and removes the workshop again at the end. Useful flags:

- `--only=<step,...>`: run a subset of steps (`--list` shows them); later steps
  assume the earlier ones ran.
- `--keep`: leave the sample project and workshop behind for inspection.
- `--scale=2`: render at 2x device pixel ratio.

Bump `VSCODE_VERSION` in `config.ts` deliberately; a new VS Code release can
change the DOM the driver relies on, so re-run and review every image after a
bump.
