---
name: knapper-usage
description: Open one private Obsidian profile with one development vault and optional plugin, then use the fixed Knapper tools.
---

# Knapper usage

Knapper controls one private Obsidian profile. The profile has one development
vault and one optional development plugin.

## Open the target

Call `obsidian_open` with an absolute vault path. Add `pluginDir` for plugin work.

```text
obsidian_open(vaultPath=/absolute/path/to/scratch-vault)
obsidian_open(vaultPath=/absolute/path/to/scratch-vault pluginDir=/absolute/path/to/plugin)
```

Call `obsidian_status` when you need readiness or window details. Call
`obsidian_close` after the work.

Do not call the old session lifecycle tools. Do not use a default profile or a
vault authorization flow. Do not create a second profile.

## Use the target

Use `obsidian_dev_cycle` after each plugin build. Its result includes load state
and attributed errors. Use `obsidian_commands` and `obsidian_command` to test
commands.

Use `obsidian_snapshot` before UI input. Pass the returned
ref as `target` to the next browser call.

## Windows and dialogs

`obsidian_status` lists the main window and popouts. Pass its `windowId` to a
window-scoped tool. Recreate refs after you change `windowId`.

Queue a prompt response with `browser_handle_dialog` before the action. Alert and
confirm dialogs are not supported. Knapper dismisses them.

## Logs and evaluation

Call `obsidian_logs` before an action. Call it again with the returned cursor as
`since` after the action. Logs include events from all windows.

`obsidian_eval` uses the main renderer and can access `app`. With `windowId`, it
runs DOM code in a popout. A popout does not expose the main renderer's `app`.
