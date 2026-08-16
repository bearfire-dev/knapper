---
name: obsidian-plugin-dev
description: Build, reload, and verify one Obsidian plugin with Knapper.
---

# Obsidian plugin development loop

Knapper loads one development plugin in one private Obsidian profile.

## Loop

1. Build the plugin on disk.
2. Call `obsidian_open` with the vault path and `pluginDir`.
3. Call `obsidian_dev_cycle` after each build.
4. Read the health verdict and attributed errors from the result.
5. Call `obsidian_logs` to inspect new errors.
6. Call `obsidian_close` after testing.

Use `obsidian_commands` to list command IDs. Use `obsidian_command` to run one.

## Telemetry

Call `obsidian_logs` before a reload or UI action. Pass its cursor as `since` to
the next `obsidian_logs` call. Logs include console output, page errors, failed
requests, and plugin errors from the main window and popouts.

## UI and evaluation

Call `obsidian_snapshot` before input. Pass a snapshot ref
as `target`. Pass `windowId` when you work in a popout. Recreate refs after you
change windows.

`obsidian_eval` runs in the main renderer and can access `app`. With `windowId`,
it evaluates DOM code in a popout.
