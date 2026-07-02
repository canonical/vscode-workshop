# Workshop — VS Code Extension

Open any [Workshop](https://snapcraft.io/workshop) project in a container with one click.

## Requirements

- [Workshop](https://snapcraft.io/workshop) installed (`snap install workshop --classic`)
- [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension (installed automatically as a dependency)

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
