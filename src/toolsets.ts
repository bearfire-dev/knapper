/** Internal classifications for specialized tool definitions. */

export const TOOLSETS = [
  "core",
  "ui",
  "telemetry",
  "plugin-dev",
  "editor",
  "vault",
  "devtools",
  "authoring",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/** All toolsets remain an internal classification for tool definitions. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = TOOLSETS;

export const TOOLSET_DESCRIPTIONS: Record<Toolset, string> = {
  core: "Status, doctor, launch, eval, CLI, and command-palette execution.",
  ui: "Browser automation over CDP (proxied from @playwright/mcp) plus Obsidian-scoped snapshots.",
  telemetry: "Console, error, and network capture with cursor-based tailing.",
  "plugin-dev": "Plugin reload, manifest and settings inspection, and dev-cycle composites.",
  editor:
    "Active-editor state (mode, cursor, doc hash), cursor and selection control, hash-guarded " +
    "text edits, and widget/decoration queries.",
  vault: "File and note CRUD, search, tabs, and graph queries (backlinks, orphans, aliases).",
  devtools: "Raw CDP passthrough, DOM/CSS inspection, OS-window screenshots, and mobile emulation.",
  authoring: "Themes, snippets, frontmatter properties, tags, tasks, daily notes, and templates.",
};

/** Public MCP tools. Other definitions are implementation details. */
export const PUBLIC_TOOL_NAMES = [
  "obsidian_open",
  "obsidian_status",
  "obsidian_close",
  "obsidian_dev_cycle",
  "obsidian_commands",
  "obsidian_command",
  "obsidian_eval",
  "obsidian_cli",
  "obsidian_logs",
  "obsidian_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_take_screenshot",
  "browser_handle_dialog",
  "browser_mouse_wheel",
  "browser_keydown",
  "browser_keyup",
] as const;

export const PUBLIC_TOOL_NAME_SET: ReadonlySet<string> = new Set(PUBLIC_TOOL_NAMES);
