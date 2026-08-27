# Workshop — VS Code Extension

Develop inside [Workshop](https://ubuntu.com/workshop) containers directly from VS Code. Workshop launches [LXD](https://canonical.com/lxd) system containers with Ubuntu from simple YAML definitions checked into your project, giving each project a clean, reproducible environment that the whole team shares.

## Requirements

- **OS**: Ubuntu 22.04 or later
- **Architecture**: amd64 or arm64
- **[LXD](https://snapcraft.io/lxd)** from the `6/stable` channel:
  ```bash
  sudo snap refresh lxd --channel=6/stable
  ```
- **[Workshop](https://snapcraft.io/workshop)** 0.9.5 or later:
  ```bash
  snap install workshop --classic
  ```
- **[Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)**, installed automatically as a dependency

## Getting Started

1. Open a terminal in your project directory and initialise a workshop:

   ```bash
   workshop init dev --sdks opencode,go/1.26/stable
   ```

   This creates a `.workshop/dev.yaml` definition. Adjust the SDK list to match your stack - see [Reference SDKs](https://github.com/canonical/reference-sdks) for the full catalogue of SDKs maintained by Canonical.

2. Open the project folder in VS Code. A **Workshop** panel appears in the Activity Bar.

3. Click **Reopen in Workshop** next to your workshop in the panel (or run **Workshop: Reopen in Workshop** from the Command Palette). VS Code reconnects inside the container.

To return to your local window at any time, click **Reopen Locally** in the Workshop panel or in the Remote indicator in the status bar.

## Restricted Mode

When VS Code opens a folder in Restricted Mode (untrusted workspace), most extensions, including this one, are disabled, which prevents using the Workshop panel to reconnect or reopen locally.

To allow this extension to run even in untrusted workspaces, add the following to your user **settings.json** (`Ctrl+Shift+P` → _Open User Settings (JSON)_):

```json
{
  "extensions.supportUntrustedWorkspaces": {
    "canonical.workshop": {
      "supported": true
    }
  }
}
```

With this in place, the Workshop panel remains active in restricted mode so you can open the project in a workshop sandbox and continue not trusting it on the host.

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
