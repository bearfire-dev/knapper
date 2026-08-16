---
name: obsidian-ui-automation
description: Drive Obsidian main and popout windows with snapshot-first Knapper browser tools.
---

# Obsidian UI automation

Use `obsidian_snapshot` before you send input.

## Refs and windows

1. Call a snapshot tool.
2. Pass its ref as `target` to `browser_click`, `browser_type`, or another input tool.
3. Pass `windowId` when you target a popout.
4. Take a new snapshot after you change `windowId`.

Refs belong to the window that produced them. Do not reuse a ref in another
window. Use `obsidian_status` to list window IDs.

## Dialogs

Call `browser_handle_dialog` before an action uses `prompt`. Set `accept` and
`promptText` to queue one response without a popup. Alert and confirm dialogs are
not supported. Knapper dismisses them.

## Evaluation and logs

Use `obsidian_eval` for main-renderer code and the Obsidian `app` object. Pass
`windowId` to evaluate DOM code in a popout. Read an `obsidian_logs` cursor
before input, then use `since` to correlate it with console and page errors.
