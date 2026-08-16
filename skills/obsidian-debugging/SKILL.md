---
name: obsidian-debugging
description: Read Knapper logs with cursors and window attribution after plugin or UI actions.
---

# Obsidian debugging

Open the target with `obsidian_open` before you debug a plugin.

## Capture a scenario

1. Call `obsidian_logs` and save its cursor.
2. Perform one plugin or UI action.
3. Call `obsidian_logs` with the saved cursor as `since`.

`obsidian_logs` returns console messages, page errors, failed requests, and
plugin errors. Each event includes its `windowId`, so main-window and popout
events remain distinct.

Use `obsidian_eval` for main-renderer probes. Pass `windowId` to inspect popout
DOM. Popouts do not expose the main renderer's `app` object.
