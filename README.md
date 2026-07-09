# Workshop — VS Code Extension

Open any [Workshop](https://snapcraft.io/workshop) project in a container with one click.

## Requirements

- [Workshop](https://snapcraft.io/workshop) installed (`snap install workshop --classic`)
- [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension (installed automatically as a dependency)

## Install locally

The extension isn't on the Marketplace yet. To install it from source, build a
`.vsix` package and install it into VS Code.

1. Build the package (runs `@vscode/vsce package` inside the workshop):

   ```bash
   workshop run build
   ```

   This produces a `workshop-<version>.vsix` file in the project root.

2. Install it into VS Code, either:
   - From the command line:

     ```bash
     code --install-extension workshop-*.vsix
     ```

   - Or from the UI: open the Extensions view, click the `...` menu, choose
     **Install from VSIX…**, and select the generated file.

3. Reload VS Code when prompted.

To update, rebuild the `.vsix` and install it again. To remove the extension,
uninstall **Workshop** from the Extensions view.

## Development

This project uses Workshop for its own development environment.

```bash
workshop launch
workshop connect ext/test-deps:desktop
```

Then open this project in VS Code and press `F5` to launch the extension in a new Extension Development Host window.

### Running tests

```bash
workshop run test
```

Tests run headlessly inside the workshop container.

### Building

```bash
workshop run build
```
