# Configuration

Knapper uses one private Obsidian profile for each MCP server. The profile has
one development vault and one optional development plugin.

## Open and close the profile

Call `obsidian_open` with an absolute `vaultPath`. Add `pluginDir` when the
profile must load a plugin.

```text
obsidian_open(vaultPath="/absolute/path/to/scratch-vault")
obsidian_open(vaultPath="/absolute/path/to/scratch-vault", pluginDir="/absolute/path/to/plugin")
```

The vault must be below the plugin Git root and Git must ignore it. Knapper
creates the vault directory when needed. The server does not use the default
Obsidian profile.

Call `obsidian_status` to read the profile, vault, plugin, transport, and window
state. Call `obsidian_close` to stop the profile and release its resources.

## Fixed tools

Knapper exposes exactly 20 tools. The list stays fixed for the MCP connection.
Knapper does not support `--toolsets`, `KNAP_TOOLSETS`, or a full mode.

The tools are:

```text
obsidian_open
obsidian_status
obsidian_close
obsidian_dev_cycle
obsidian_commands
obsidian_command
obsidian_eval
obsidian_cli
obsidian_logs
obsidian_snapshot
browser_click
browser_type
browser_press_key
browser_hover
browser_drag
browser_take_screenshot
browser_handle_dialog
browser_mouse_wheel
browser_keydown
browser_keyup
```

Knapper does not include graph or canvas tools. It does not include tools 5
through 8 from the former plan.

## Environment variables

| Variable                 | Default          | Purpose                                   |
| ------------------------ | ---------------- | ----------------------------------------- |
| `OBSIDIAN_BIN`           | OS default       | Obsidian executable                       |
| `KNAP_HOME`              | `~/.knapper_mcp` | Private profile and telemetry root        |
| `KNAP_LOG_LEVEL`         | `info`           | Server log level                          |
| `KNAP_TELEMETRY_BUFFER`  | `2000`           | In-memory telemetry record limit          |
| `KNAP_TELEMETRY_NETWORK` | `false`          | Capture failed network requests           |
| `KNAP_SCREENSHOT_DIR`    | `./.knapper`     | Screenshot output root                    |
| `MCP_TRANSPORT`          | `stdio`          | MCP transport                             |
| `MCP_PORT`               | `9223`           | HTTP port when HTTP transport is selected |
| `MCP_HOST`               | `127.0.0.1`      | HTTP bind host                            |

Knapper ignores tool-selection flags. The HTTP transport has no authentication.
Bind it to `127.0.0.1` or `::1`.

## Windows and dialogs

`obsidian_status` lists the main window and any popout windows. Pass a
`windowId` to snapshot, browser input, screenshot, and evaluation tools.

Refs are local to one window. Take a new snapshot after you change `windowId`.
Do not pass a ref from one window to a tool that targets another window.

Call `browser_handle_dialog` before an action uses `prompt`. The tool queues one
response, so no popup opens. Set `accept` and `promptText` for the response.
Alert and confirm dialogs are not supported. Knapper dismisses them so that
automation does not hang.

## Evaluation and telemetry

`obsidian_eval` evaluates code in the main renderer. The main renderer exposes
the Obsidian `app` object. With `windowId`, the tool evaluates DOM code in a
popout. A popout does not expose the main renderer's `app` object.

`obsidian_logs` reads console output, page errors, failed requests, and plugin
errors from all attached windows. Each record includes its `windowId`.

Call `obsidian_logs` before a test. Pass its cursor as `since` to
`obsidian_logs` after the test.
