---
name: obsidian-instance-setup
description: Open and close one private Obsidian profile for Knapper plugin work.
---

# Obsidian instance setup

Knapper starts one private profile with one development vault. It can load one
development plugin.

## Open

1. Call `obsidian_open` with an absolute `vaultPath`.
2. Add `pluginDir` when the target must load a plugin.
3. Call `obsidian_status` if the open result reports a warning.

```text
obsidian_open(vaultPath=/absolute/path/to/scratch-vault pluginDir=/absolute/path/to/plugin)
obsidian_status()
```

Do not use session tools, default-profile targets, or authorization commands.
Knapper creates only one private profile for the active development vault.

## Close

Call `obsidian_close` after the test. The call stops the private profile and
releases its resources.

## Readiness

`obsidian_status` reports the profile, vault, plugin, transports, and attached
windows. If Obsidian is not ready, fix the reported condition and call
`obsidian_open` again.
