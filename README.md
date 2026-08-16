# knapper

Knapper is an MCP server for a live Obsidian desktop application. It supports
plugin development, note access, UI automation, popout windows, and telemetry.

Knapper opens one private Obsidian profile for each MCP server. The profile has
one development vault and, when requested, one development plugin.

## Install

Install Knapper from a release or run it from a checkout:

```bash
npx -y github:bearfire-dev/knapper
```

The server needs Node.js 20 or later and Obsidian 1.12 or later. Linux is the
only platform with live test coverage.

## Start a development target

Call `obsidian_open` before you use Obsidian tools. Pass an absolute `vaultPath`.
Pass `pluginDir` when you want Knapper to load one development plugin.

```text
obsidian_open(vaultPath="/absolute/path/to/scratch-vault", pluginDir="/absolute/path/to/plugin")
```

The vault path must be below the Git root that owns `pluginDir`, or the current
working directory when `pluginDir` is absent. Git must ignore the path. Knapper
creates the directory when needed.

Knapper starts one private profile and selects the vault. It does not use the
default profile or ask for a vault authorization.
Call `obsidian_status` to inspect the live target. Call `obsidian_close` when the
work is complete.

`obsidian_open` and `obsidian_close` are idempotent. Call `obsidian_close` before
you open a different vault or plugin.

## Fixed tool surface

Knapper always exposes exactly these 20 tools. It does not support tool flags,
toolsets, or a full mode. The tool list does not change after initialization.

| Area           | Tools                                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target         | `obsidian_open`, `obsidian_status`, `obsidian_close`                                                                                                                                                                      |
| App and plugin | `obsidian_dev_cycle`, `obsidian_commands`, `obsidian_command`, `obsidian_eval`, `obsidian_cli`                                                                                                                            |
| Telemetry      | `obsidian_logs`                                                                                                                                                                                                           |
| UI             | `obsidian_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_take_screenshot`, `browser_handle_dialog`, `browser_mouse_wheel`, `browser_keydown`, `browser_keyup` |

Knapper does not expose graph or canvas tools. It also does not expose the old
tools numbered 5 through 8 in the former tool plan.

## Popout windows and dialogs

Obsidian popouts are browser pages in the same CDP context. Tools that inspect or
control a page accept `windowId`. Use the `windowId` from `obsidian_status` or
`obsidian_snapshot`.

Refs belong to the window that produced them. Call `obsidian_snapshot` again
after you change `windowId`. Do not use a ref from one window in another window.

Call `browser_handle_dialog` before an action that uses JavaScript `prompt`.
The tool queues one response for that window, so no popup opens. Set `accept`
and `promptText` for the response. Alert and confirm dialogs are not supported.
Knapper dismisses them so that automation does not hang.

`obsidian_logs` captures console messages, page errors, failed requests, and
plugin errors from the main window and popout windows. Each record identifies
its window. Read the current cursor before an action, then pass it as `since` on
the next `obsidian_logs` call.

`obsidian_eval` runs in the main Obsidian renderer and can access the Obsidian
`app` object. Pass `windowId` to evaluate DOM code in a popout. A popout does not
provide the main renderer's `app` object.

## Configuration

Use environment variables for server settings. Knapper does not select tools
with flags or toolsets.

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

The HTTP transport has no authentication. Bind it to loopback only.

## Development checks

```bash
npm run check
npm run typecheck
npm test
npm run build
npm run smoke
```

The live checks need a desktop Obsidian instance. Use a scratch vault and the
same `obsidian_open` call that you use for plugin work.

## Security

Knapper can execute JavaScript in Obsidian, send real input, read logs, and edit
vault files. Review MCP approvals and use a disposable development vault.

## License

MIT
