# Obsidian connection doctor

Diagnose why knapper cannot talk to Obsidian and fix each layer explicitly.

## Run

1. Call **`obsidian_doctor`** and read the structured JSON problems list.
2. For each problem, run the suggested **`fixedBy`** tool or follow **remediation** text:
   - `OBSIDIAN_NOT_RUNNING` → `obsidian_launch`
   - `CLI_DISABLED` → `obsidian_setup_cli`
   - `CDP_PORT_CLOSED` → quit Obsidian completely, then `obsidian_launch` (single-instance lock)
   - `ARGV_CORRUPTION` → edit `user-flags.conf` to use `--` prefixes
   - `VAULT_NOT_FOUND` → fix `OBSIDIAN_VAULT` or register the vault in Obsidian
3. Call **`obsidian_session_status`** to confirm the active target and read its `cdpUrl`.
4. If an isolated session is active, use its `cdpUrl` for CDP checks.
5. If the default profile is active, use `OBSIDIAN_CDP_URL` for CDP checks when it is set.
   Use port `9222` only when `OBSIDIAN_CDP_URL` is unset.

## Reference

Use skill **obsidian-instance-setup** for the single managed session lifecycle.
