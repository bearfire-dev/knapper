# Configuration

Knapper reads CLI flags first, then environment variables, then defaults. Tool
calls use one active Obsidian session. The session state does not depend on agent
handles or transport reconnect state.

## Connection and process settings

| Environment variable     | CLI flag         | Default                 | Purpose                                    |
| ------------------------ | ---------------- | ----------------------- | ------------------------------------------ |
| `OBSIDIAN_CDP_URL`       | `--cdp-url`      | `http://127.0.0.1:9222` | Default-profile CDP endpoint               |
| `OBSIDIAN_BIN`           | `--obsidian-bin` | OS default              | Obsidian executable                        |
| `OBSIDIAN_VAULT`         | `--vault`, `-v`  | unset                   | Default authorized vault name              |
| `OBSIDIAN_TARGET_MATCH`  | `--target-match` | unset                   | Additional default-window match            |
| `KNAP_HOME`              | none             | `~/.knapper_mcp`        | Session state, telemetry, audit, and trash |
| `KNAP_IDLE_TIMEOUT_MS`   | none             | `86400000`              | Inactive session cleanup time              |
| `KNAP_ACTIVITY_IDLE_MS`  | none             | `300000`                | Single-agent activity ownership time       |
| `KNAP_COMMAND_TRANSPORT` | none             | `auto`                  | `auto`, `cli`, or `playwright`             |
| `KNAP_CLI_TIMEOUT_MS`    | none             | `15000`                 | Obsidian CLI timeout in milliseconds       |

Knapper creates a private profile and runtime directory for a managed session.
One live process owns the activity record. Another process receives
`KNAPPER_BUSY`. The record includes the process ID, session state, current
operation, last activity, and retry time. Knapper reclaims stale state only after
it verifies process death or an expired activity record.

An isolated session always creates an exact scratch layout under `KNAP_HOME`.
It cannot adopt a caller path. Knapper verifies the private-session identity before
it routes tools. The result returns `visualIdentity.state` and
`visualIdentity.warnings`. A session does not become ready when the required
banner, title, icon, or desktop class is missing.

Call `obsidian_session_release` to release the active claim. The private app and
scratch vault stay ready for the next agent.
Call `obsidian_session_reset` to replace it. Cleanup checks path, symlink, device,
and inode ownership. It moves the root into `KNAP_HOME/trash`. It never
hard-deletes the root.

## Tool surface

| Environment variable  | CLI flag       | Default                                 | Purpose                       |
| --------------------- | -------------- | --------------------------------------- | ----------------------------- |
| `KNAP_TOOLSETS`       | `--toolsets`   | core, ui, telemetry, plugin-dev, editor | Startup toolset selection     |
| `KNAP_SCREENSHOT_DIR` | `--output-dir` | `./.knapper`                            | Default-profile artifact root |

Knapper publishes the complete tool surface during MCP initialization. The list
does not change during a connection. Do not change the tool list after startup.
Knapper runs one operation at a time.

The session lifecycle tools are always available. They stay available when
`KNAP_TOOLSETS` excludes `core`, so an agent can open, inspect, release, or reset
the active session. `KNAP_TOOLSETS` controls the other toolsets at startup.

The default `core` toolset includes `obsidian_eval` and `obsidian_cli`. These tools
can run renderer JavaScript and raw Obsidian CLI commands. Remove `core` from an
explicit `KNAP_TOOLSETS` value when a client must not have those capabilities.

## Structured output

Knapper tools publish MCP output schemas. Successful calls return values through
`structuredContent`. Clients do not need to parse the display text.

Screenshot tools return this object:

```json
{
  "path": "/absolute/path/to/output/capture.png",
  "mimeType": "image/png",
  "size": 12345,
  "inline": false
}
```

The requested `path` must be relative to the configured output root. Screenshot
tools do not return inline base64 data. Private sessions use their private
`output/` root.

Doctor returns explicit version information in this shape:

```json
{
  "versions": {
    "running": "1.12.7",
    "downloadedAsar": "1.12.7",
    "installedPackage": "1.12.7",
    "installedPackageSource": "pacman",
    "comparisons": {
      "runningVsDownloaded": "match",
      "runningVsInstalled": "match",
      "downloadedVsInstalled": "match"
    }
  }
}
```

Each comparison is `match`, `different`, or `unavailable`. An unavailable source
produces `unavailable` instead of an inferred result.

The four version source fields can be `null`. `installedPackageSource` identifies
the package manager that supplied `installedPackage`.

## Telemetry and audit

| Environment variable     | Default | Purpose                          |
| ------------------------ | ------- | -------------------------------- |
| `KNAP_LOG_LEVEL`         | `info`  | Server log level                 |
| `KNAP_TELEMETRY_BUFFER`  | `2000`  | In-memory telemetry record limit |
| `KNAP_TELEMETRY_NETWORK` | `false` | Capture failed network requests  |
| `KNAP_RECONNECT_MS`      | `2000`  | Telemetry reconnect delay        |

Knapper writes default-profile telemetry to `KNAP_HOME/telemetry/events.jsonl`.
The managed session uses `KNAP_HOME/telemetry/session.jsonl`. Knapper
writes redacted tool audit events under `KNAP_HOME/audit`. Audit files use mode
`0600` and have 14-day retention.

Session reset archives its telemetry in the quarantined root. Session release does
not archive telemetry because it keeps the private session ready for reuse.

`LOG_LEVEL`, `RECONNECT_MS`, and `SCREENSHOT_DIR` are supported aliases. The
`KNAP_` name takes precedence.

## HTTP transport

| Environment variable | CLI flag      | Default     | Purpose                  |
| -------------------- | ------------- | ----------- | ------------------------ |
| `MCP_TRANSPORT`      | `--transport` | `stdio`     | `stdio` or `http`        |
| `MCP_PORT`           | `--port`      | `9223`      | HTTP listen port         |
| `MCP_HOST`           | `--host`      | `127.0.0.1` | Exact loopback bind host |

HTTP is experimental. It serves `/mcp` with one global lane and one active session.
It does not issue an `Mcp-Session-Id`. Each request uses the active session.

The HTTP server has no authentication. The listener accepts only `127.0.0.1` or
`::1` as the bind host. It rejects `localhost`, wildcard addresses, and LAN
addresses. Requests can use `localhost`, `127.0.0.1`, or `[::1]` in their `Host`
and `Origin` headers. Do not place the server behind a public proxy.

## Vault authorization

The Obsidian vault registry is discovery data, not consent. A user must create an
external authorization from an interactive terminal:

```text
knapper authorize /absolute/path/to/vault
knapper revoke /absolute/path/to/vault
knapper authorizations
```

Knapper stores authorizations in `KNAP_HOME/vault-authorizations.json`. Each record
binds the canonical path to its device and inode. Legacy `.knapper-managed` files
have no effect. Authorization permits vault operations. It never permits directory
deletion.

`obsidian_create_vault` refuses when a private session is selected. Use the
scratch vault that `obsidian_session_open` created for that session.
