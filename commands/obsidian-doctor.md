# Obsidian connection check

Call `obsidian_status` to inspect the private profile, vault, plugin, transports,
and windows. If the target is not ready, call `obsidian_open` again with the
same `vaultPath` and optional `pluginDir`.

Knapper does not expose a separate doctor tool. It does not use the default
profile or a vault authorization flow.
