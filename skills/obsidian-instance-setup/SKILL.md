---
name: obsidian-instance-setup
description: Connect Knapper to one live Obsidian app with a stateless session. Use for doctor diagnosis, private scratch sessions, launch, CLI enablement, and registry safety.
---

# Obsidian instance setup

Use one private session for plugin development and experiments. Use the default
profile only when the user explicitly requests an existing vault.

## Open a session

1. Call `obsidian_session_open` with `pluginSourceDir` and `pluginId`.
2. Call `obsidian_session_status` to inspect the target.
3. Call `obsidian_status` to confirm that the owner state is `self`.
4. Call `obsidian_doctor` when a transport is not ready.

```text
obsidian_session_open pluginSourceDir=/abs/path/to/dist pluginId=my-plugin
obsidian_session_status
obsidian_plugin_health pluginId=my-plugin
```

Operational tools use the active target. They do not need caller-owned identifiers.
Knapper keeps one managed session and runs one operation at a time.

Use these lifecycle tools:

```text
obsidian_session_status
obsidian_session_release
obsidian_session_reset
```

`release` drops the agent claim and keeps the app ready for reuse. `reset` replaces the private
target and moves verified old roots to recoverable Knapper trash. Knapper never
hard-deletes a managed root.

## Busy state

`obsidian_status` reports `free`, `self`, `busy`, or `stale`. It also reports the
last activity time and `retryAfterMs`. A second process receives `KNAPPER_BUSY`.
Wait for the retry interval, then check status again. Knapper reclaims stale state
only after it verifies process death or an expired activity record.

## Default profile

Call `obsidian_session_open` with `target="default"` only for a user-approved
default-profile task. Existing vault access still requires terminal authorization.

| State                  | Meaning                                  | Action                            |
| ---------------------- | ---------------------------------------- | --------------------------------- |
| `OBSIDIAN_NOT_RUNNING` | Obsidian is stopped                      | Call `obsidian_launch`            |
| `CLI_DISABLED`         | Native CLI is disabled                   | Call `obsidian_setup_cli`         |
| `CDP_PORT_CLOSED`      | Browser automation cannot attach         | Cold-start with `obsidian_launch` |
| `ARGV_CORRUPTION`      | A wrapper passed a bad single-dash token | Correct `user-flags.conf`         |
| `KNAPPER_BUSY`         | Another process is active                | Wait for `retryAfterMs`           |
| `VAULT_NOT_AUTHORIZED` | The user did not grant vault access      | Stop                              |

The Obsidian CLI prints some failures to stdout with exit code 0. Trust the typed
Knapper result, not the process exit code.

## Vault safety

A private session creates Knapper-owned scratch space. It cannot adopt a caller
vault path. Knapper stores authorization outside the vault. It checks the exact
layout, real path, symlink state, device, and inode before cleanup.

An Obsidian registry entry does not authorize access. Only the user can authorize
an existing vault from an interactive terminal. Authorization never permits
vault-directory deletion.

## Fixed tool surface

Knapper publishes the complete tool surface during MCP initialization. The list
does not change during a connection. Do not change the tool list after startup.

## Safety limits

Private sessions use a private profile. On Linux, a private `XDG_RUNTIME_DIR` also
isolates the CLI socket per session. macOS uses a shared socket, and Windows has no
per-session socket input. Treat native CLI routing outside Linux as shared or
unavailable. Restart operations remain scoped to the managed process. Knapper
never uses the default profile as a fallback.

## Related skills

- Use **obsidian-plugin-dev** after the session is ready.
- Use **obsidian-ui-automation** for snapshot-first UI work.
- Use **obsidian-debugging** for console and network telemetry.
