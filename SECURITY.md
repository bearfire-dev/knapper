# Security

## What Knapper controls

Knapper drives one live Obsidian desktop application. It can execute JavaScript
in the renderer. It can also send real mouse and keyboard input, run Obsidian CLI
commands, and start or stop Obsidian.

Treat Knapper as desktop automation. Register it only with MCP clients that you
trust.

## Fixed development target

`obsidian_open` requires an absolute `vaultPath`. Knapper accepts the path only
when all these conditions are true:

- The path is below the plugin Git repository.
- Git ignores the path.
- The repository, plugin, and vault paths do not contain symbolic links.
- The path identifies a directory, or Knapper can create the directory.

Put the development vault in the plugin repository and add it to `.gitignore`.
For example, use `<repo>/.knapper/vault`.

Knapper starts one private Obsidian profile for that vault. It does not attach to
the default Obsidian profile. One Knapper process can have one active vault and
one optional linked plugin. Call `obsidian_close` before you select a different
vault or plugin.

`obsidian_close` stops the private Obsidian process and removes the plugin link.
It does not delete the development vault.

## Vault fence

Every Obsidian CLI and CDP operation passes through the vault fence. The fence
binds the active session to the canonical vault path and its file-system
identity. CLI operations include the vault scope and use the private session
process. CDP operations check the selected Obsidian window.

The fence also covers these paths:

- Browser input routes only to an authorized main window or popout.
- Telemetry captures data only from authorized windows.
- Direct plugin-link writes resolve the active authorized vault first.
- Window reports hide metadata for unauthorized windows.

An unscoped Obsidian CLI call can reach the last focused vault. Knapper refuses
to emit one. A CDP call can reach the wrong Obsidian window. Knapper refuses a
call when it cannot match the requested window to the active vault.

## MCP trust boundary

Knapper does not authenticate stdio callers. It trusts the MCP host to control
access to its tools. Each public tool includes MCP annotations such as
`readOnlyHint` and `destructiveHint`.

The default stdio transport does not open a network listener. The optional HTTP
transport binds to loopback. Knapper rejects non-loopback hosts because the HTTP
transport has no authentication.

## Powerful tools

### `obsidian_eval`

This tool runs the supplied JavaScript in the selected Obsidian window. Code in
the main window can access `app`, the DOM, and exposed Electron APIs. Code in a
popout can access that popout DOM. Knapper does not sanitize the code.

### `obsidian_cli`

This tool sends one native command and its arguments to the active vault. The
available Obsidian commands can read or change vault data. Knapper always adds
the vault scope and passes arguments without a shell.

### Browser input

The public browser tools send real input to the selected authorized window.
Knapper does not expose navigation, page creation, page closing, file upload,
raw browser code, or storage-state tools.

`browser_handle_dialog` does not control a native dialog. It queues one response
for the next JavaScript `prompt` call in the selected page. Knapper dismisses
native alert and confirm dialogs so that automation does not hang.

## Files written by Knapper

| Path                             | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `<KNAP_HOME>/sessions/`          | Private session descriptors and process state               |
| Private Obsidian profile         | Vault registry, CLI setting, and isolated application state |
| `<vault>/.obsidian/`             | Obsidian settings for the development vault                 |
| `<vault>/.obsidian/plugins/<id>` | Link to the optional development plugin                     |
| Configured output directory      | Screenshots and other requested artifacts                   |

Knapper can create the selected development vault. It never deletes that vault
through the public tool surface.

## Input handling

Knapper starts processes with `execFile`. It does not pass user input through a
shell. CLI argument escaping stays in the Obsidian command layer.

The path checks use canonical paths and reject symbolic-link components. Git
must confirm that it ignores the selected vault before Knapper creates or opens
the vault.

## Timeouts and logs

A single Obsidian CLI operation stops after `KNAP_CLI_TIMEOUT_MS`. The default is
15 seconds.

Server logs go to stderr. Stdout contains only MCP protocol data. Debug logs can
contain tool arguments. Review them before you publish a recording or bug report.

## Report a vulnerability

Open a [security advisory](https://github.com/bearfire-dev/knapper/security/advisories/new).
Use a regular issue only when the report does not contain sensitive information.
