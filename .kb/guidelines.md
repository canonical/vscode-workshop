# Knowledge base

Rules for every feature of the extension, including prototypes built with
agents. A spec that seems to allow a breach is wrong, not the rule.

1. **Thin client; the CLI is the reference.** Every action the extension
   offers is one the CLI has, and the extension has no action the CLI
   lacks. It shows what the daemon reports and never listens, forwards or
   resolves anything itself.
2. **Many clients, one workshop.** The extension rebuilds what it shows from
   daemon polling: the daemon is the only record of what is or was wired. A
   change made elsewhere shows up on the next poll, or fails a colliding
   action through the ordinary path. Wiring, such as mounts, tunnels,
   addresses or flags, is never persisted in `globalState`, `workspaceState`
   or on disk. The only state kept across polls is screen state, such as
   a switch's optimistic position, which never reaches the daemon or disk
   and is dropped when what it refers to is gone.
3. **The extension never edits the workshop definition itself.** It's the
   user's hand edit plus a refresh.
4. **Consistency.** New features reuse what exists rather than reinvent it.
   For example, new tabs (Devices, …) extend the existing panel (files named
   `mountsPanel.*` plus `src/interfaces/`): add a tab, cell renderers and a
   row type. No second webview or table.
