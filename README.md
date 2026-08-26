# Workshop — VS Code Extension

Open a [Workshop](https://snapcraft.io/workshop) project in a container from VS Code.

## Requirements

- [Workshop](https://snapcraft.io/workshop): `snap install workshop --classic`
- [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh), installed automatically as a dependency

## Install locally

Build and install a local `.vsix`:

```bash
workshop launch
workshop run -- build
code --install-extension workshop-*.vsix
```

Reload VS Code when prompted. To update, rebuild and reinstall the `.vsix`.

## Development

This project uses Workshop for its development environment:

```bash
workshop launch
workshop connect ext/test-deps:desktop
```

Open the project in VS Code and press `F5` to start an Extension Development Host.

Useful commands:

```bash
workshop run -- test
workshop run -- build
```
