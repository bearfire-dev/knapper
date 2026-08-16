# Obsidian plugin development

Use the fixed Knapper tools to build and test one plugin in one private profile.

1. Build the plugin on disk.
2. Call `obsidian_open` with `vaultPath` and `pluginDir`.
3. Call `obsidian_dev_cycle`.
4. Call `obsidian_logs` to inspect new events.
5. Call `obsidian_close` after testing.

The dev-cycle result includes load state. Use `obsidian_commands` and
`obsidian_command` for command tests.
