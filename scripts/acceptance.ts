/**
 * End-to-end acceptance run against a live Obsidian.
 *
 * Drives the built server over real MCP stdio exactly as a client would, so this
 * exercises tool registration, schema validation, the capability router, and the
 * transports together — things unit tests with mocked CDP cannot cover.
 *
 * The suite launches a private Obsidian profile with a temporary CDP port.
 *
 *   npm run acceptance
 */

import { spawn } from "node:child_process";
import { createDisposableWorkspace, createLiveHome, removeLiveHome } from "./lib/live-harness.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stat } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };
interface McpContent {
  type?: string;
  text?: string;
}
interface McpTool {
  name: string;
  description?: string;
}
interface McpJson {
  cursor?: number;
  matched?: number;
  mimeType?: string;
  size?: number;
  path?: string;
  argvCorruption?: unknown;
  windows?: Array<{ windowId?: string; kind?: string }>;
  dialogId?: string;
  windowId?: string;
  type?: string;
}
interface McpResult {
  serverInfo?: { name?: string; version?: string };
  tools?: McpTool[];
  content?: McpContent[];
  structuredContent?: McpJson;
  isError?: boolean;
}
interface JsonRpcResponse {
  id?: number;
  error?: { message: string };
  result?: McpResult;
}
type ToolResult = { text: string; images: McpContent[]; json?: McpJson; isError: boolean };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let VAULT: string | undefined;
const PLUGIN = process.env.PLUGIN_ID;

class McpClient {
  #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #pending = new Map<number, (message: JsonRpcResponse) => void>();
  #nextId = 1;

  constructor(args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
    this.#child = spawn("node", [join(root, "dist", "cli.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk) => {
      if (process.env.VERBOSE) process.stderr.write(chunk);
    });
  }

  #onData(chunk: Buffer) {
    this.#buffer += chunk.toString();
    let index;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "") continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = message.id === undefined ? undefined : this.#pending.get(message.id);
      if (resolver) {
        this.#pending.delete(message.id as number);
        resolver(message);
      }
    }
  }

  send(method: string, params: JsonObject = {}): Promise<JsonRpcResponse> {
    const id = this.#nextId++;
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.#pending.set(id, resolve);
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 90_000);
    });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  notify(method: string, params?: JsonObject): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const res = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async call(name: string, args: JsonObject = {}): Promise<ToolResult> {
    const res = await this.send("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    const content = res.result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) =>
        typeof c === "object" && c !== null && !Array.isArray(c) ? String(c.text ?? "") : "",
      )
      .join("\n");
    const images = content.filter((c) => c.type === "image");
    return {
      text,
      images,
      json: res.result?.structuredContent,
      isError: res.result?.isError === true,
    };
  }

  close() {
    this.#child.stdin.end();
  }
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(
  label: string,
  fn: () => Promise<string | undefined> | string | undefined,
): Promise<void> {
  process.stdout.write(`  ${label} ... `);
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS${detail ? ` (${detail})` : ""}`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    failed++;
    failures.push(`${label}: ${message}`);
    console.log(`FAIL — ${message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const liveHome = await createLiveHome("knapper-acceptance-");
const client = new McpClient([], liveHome.env);

try {
  console.log("\n=== Unified Obsidian MCP — acceptance run ===\n");
  const init = await client.initialize();
  console.log(
    `server: ${init.result?.serverInfo?.name ?? "unknown"} v${init.result?.serverInfo?.version ?? "unknown"}\n`,
  );
  const isolated = await createDisposableWorkspace(client, root, {
    home: liveHome.home,
    label: "acceptance-scratch",
    ...(process.env.PLUGIN_SOURCE_DIR !== undefined
      ? { pluginSourceDir: process.env.PLUGIN_SOURCE_DIR }
      : {}),
  });
  VAULT = isolated.session.vault?.name;
  assert(typeof VAULT === "string", "isolated workspace has no vault identity");
  for (const [path, content] of [
    ["Notes/Alpha.md", "# Alpha\n\nxylophone-marmalade\n"],
    ["Notes/Beta.md", "# Beta\n\n- [ ] An open task\n"],
  ]) {
    const created = await client.call("obsidian_eval", {
      code: `(async () => {
        const path = ${JSON.stringify(path)};
        const content = ${JSON.stringify(content)};
        const parent = path.split("/").slice(0, -1).join("/");
        if (parent && !app.vault.getAbstractFileByPath(parent)) await app.vault.createFolder(parent);
        const existing = app.vault.getAbstractFileByPath(path);
        if (existing) await app.vault.modify(existing, content);
        else await app.vault.create(path, content);
        return path;
      })()`,
    });
    assert(!created.isError, `fixture creation failed for ${path}: ${created.text}`);
  }

  // ------------------------------------------------------------------ surface
  console.log("Tool surface");
  const listed = await client.send("tools/list");
  const tools = listed.result?.tools ?? [];
  const names = new Set(tools.map((t) => t.name));

  await check("the public surface contains exactly 20 tools", () => {
    assert(tools.length === 20, `found ${tools.length} tools`);
    return `${tools.length} tools`;
  });

  await check("every tool has a non-trivial description", () => {
    const bad = tools.filter((t) => !t.description || t.description.length < 40);
    assert(bad.length === 0, `thin descriptions: ${bad.map((t) => t.name).join(", ")}`);
  });

  await check("destructive browser tools are withheld", () => {
    const banned = [
      "browser_close",
      "browser_navigate",
      "browser_resize",
      "browser_run_code_unsafe",
    ];
    const leaked = banned.filter((n) => names.has(n));
    assert(leaked.length === 0, `exposed: ${leaked.join(", ")}`);
  });

  await check("no duplicate tool names", () => {
    assert(names.size === tools.length, "duplicates present");
  });

  // -------------------------------------------------------------- preconditions
  console.log("\nPreconditions");
  await check("obsidian_status shows both transports live", async () => {
    const { text } = await client.call("obsidian_status");
    assert(/CLI transport: enabled/.test(text), "CLI transport not enabled");
    assert(/CDP transport: attached/.test(text), "CDP transport not attached");
  });

  await check("obsidian_status reports the main window", async () => {
    const { text } = await client.call("obsidian_status");
    assert(/main/i.test(text), "no main window classified");
  });

  // ------------------------------------------------------------------- CLI path
  console.log("\nObsidian CLI transport");
  await check("obsidian_eval reaches the app object", async () => {
    const { text } = await client.call("obsidian_eval", { code: "app.vault.getName()" });
    assert(text.includes(VAULT ?? ""), `got: ${text.slice(0, 80)}`);
    return text.trim().slice(0, 40);
  });

  await check("obsidian_commands introspects the live command table", async () => {
    const { text } = await client.call("obsidian_commands", {});
    assert(text.length > 100, "suspiciously small command list");
  });

  await check("obsidian_cli performs real content search", async () => {
    const { text } = await client.call("obsidian_cli", {
      command: "search",
      args: ["query=xylophone-marmalade"],
    });
    assert(/Alpha/.test(text), `expected Notes/Alpha.md, got: ${text.slice(0, 120)}`);
    // The phrase appears only in the body, never in a filename, so a path-substring
    // implementation would find nothing here.
  });

  await check("obsidian_cli returns note content", async () => {
    const { text } = await client.call("obsidian_cli", {
      command: "read",
      args: ["path=Notes/Beta.md"],
    });
    assert(/An open task/.test(text), `unexpected content: ${text.slice(0, 120)}`);
  });

  // ---------------------------------------------------------------- browser path
  console.log("\nBrowser automation over CDP");
  await check("obsidian_snapshot returns real Obsidian UI", async () => {
    const { text } = await client.call("obsidian_snapshot", { scope: "workspace" });
    assert(text.length > 200, "snapshot too small");
    assert(/ref=[^:\s]+:e\d+/.test(text), "no window-scoped refs in snapshot");
    return `${text.length} chars`;
  });

  await check("obsidian_snapshot scopes to the active leaf", async () => {
    const { text } = await client.call("obsidian_snapshot", { scope: "active-leaf" });
    assert(text.length > 20, "scoped snapshot empty");
    return `${text.length} chars`;
  });

  await check("browser_take_screenshot returns an artifact reference", async () => {
    const { images, json } = await client.call("browser_take_screenshot");
    assert(images.length === 0, "screenshot must not return inline image content");
    assert(json?.mimeType === "image/png", "screenshot did not return PNG metadata");
    assert(Number(json?.size) > 1000, "screenshot artifact is suspiciously small");
    assert(json?.path !== undefined, "screenshot did not return a path");
    await stat(json.path);
    return `${json.mimeType}, ${json.size} bytes`;
  });

  // ---------------------------------------------------------- popouts + dialogs
  console.log("\nPopout windows and dialogs");
  let popoutWindowId: string | undefined;
  await check("obsidian_status distinguishes a popout window", async () => {
    const opened = await client.call("obsidian_eval", {
      code: `(() => {
        const leaf = app.workspace.openPopoutLeaf();
        return leaf != null;
      })()`,
    });
    assert(!opened.isError, `could not open popout: ${opened.text}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    const status = await client.call("obsidian_status");
    popoutWindowId = status.json?.windows?.find((window) => window.kind === "popout")?.windowId;
    assert(typeof popoutWindowId === "string", `no popout in status: ${status.text}`);
    return popoutWindowId;
  });

  await check("obsidian_eval runs in the selected popout", async () => {
    assert(popoutWindowId !== undefined, "popout was not created");
    const result = await client.call("obsidian_eval", {
      windowId: popoutWindowId,
      code: "document.body.dataset.knapperPopoutProbe = 'ready', document.body.dataset.knapperPopoutProbe",
    });
    assert(!result.isError && /ready/.test(result.text), result.text);
  });

  for (const dialog of ["prompt"] as const) {
    await check(`browser_handle_dialog supports ${dialog}`, async () => {
      const setup = await client.call("obsidian_eval", {
        code: `(() => {
          let button = document.querySelector("#knapper-dialog-probe");
          if (!button) {
            button = document.createElement("button");
            button.id = "knapper-dialog-probe";
            button.textContent = "Open test dialog";
            button.style.cssText = "position:fixed;top:80px;left:80px;z-index:2147483647";
            document.body.append(button);
          }
          button.onclick = () => {
            globalThis.__knapperDialogResult = prompt("knapper prompt", "default");
          };
          return true;
        })()`,
      });
      assert(!setup.isError, setup.text);
      const queued = await client.call("browser_handle_dialog", {
        accept: true,
        promptText: "typed response",
      });
      assert(!queued.isError, queued.text);
      const clicked = await client.call("browser_click", {
        target: "#knapper-dialog-probe",
        element: "test dialog button",
      });
      assert(!clicked.isError, `click failed before ${dialog}: ${clicked.text}`);
      const expected = "typed response";
      const result = await client.call("obsidian_eval", {
        code: "globalThis.__knapperDialogResult",
      });
      assert(result.text.includes(expected), `unexpected ${dialog} result: ${result.text}`);
    });
  }

  // ------------------------------------------------------------------ telemetry
  console.log("\nTelemetry");
  let cursorAfterMark;
  await check("obsidian_logs returns a cursor", async () => {
    const { json } = await client.call("obsidian_logs", { limit: 5 });
    assert(Number.isFinite(json?.cursor), "no cursor in response");
    cursorAfterMark = Number(json?.cursor);
    return `cursor=${cursorAfterMark}`;
  });

  await check("cursor tailing returns only new records", async () => {
    const before = await client.call("obsidian_logs", { limit: 1 });
    const cursor = Number(before.json?.cursor);
    // Generate exactly one new console record.
    await client.call("obsidian_eval", { code: 'console.log("acceptance-probe"), 1' });
    await new Promise((r) => setTimeout(r, 1200));
    const after = await client.call("obsidian_logs", { since: cursor });
    const matched = Number(after.json?.matched ?? -1);
    assert(matched >= 0, "no matched count returned");
    assert(matched < 50, `tailing returned ${matched} records, looks like a full replay`);
    return `${matched} new`;
  });

  await check("popout logs include their window id", async () => {
    assert(popoutWindowId !== undefined, "popout was not created");
    const before = await client.call("obsidian_logs", { limit: 1 });
    const cursor = Number(before.json?.cursor);
    await client.call("obsidian_eval", {
      windowId: popoutWindowId,
      code: 'console.log("acceptance-popout-log"), true',
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    const after = await client.call("obsidian_logs", {
      since: cursor,
      windowId: popoutWindowId,
    });
    assert(after.text.includes("acceptance-popout-log"), after.text);
    assert(after.text.includes(popoutWindowId), "log text omitted the popout window id");
  });

  // ------------------------------------------------------------------ dev cycle
  console.log("\nPlugin dev cycle");
  if (PLUGIN !== undefined && process.env.PLUGIN_SOURCE_DIR !== undefined) {
    await check("obsidian_dev_cycle reloads and reports", async () => {
      const { text, isError } = await client.call("obsidian_dev_cycle");
      assert(!isError, `dev cycle errored: ${text.slice(0, 200)}`);
      return text.split("\n")[0]?.slice(0, 60);
    });

    await check("telemetry attributes a deliberate plugin throw", async () => {
      const before = await client.call("obsidian_logs", { limit: 1 });
      const cursor = Number(before.json?.cursor);
      await client.call("obsidian_command", { id: `${PLUGIN}:throw-on-purpose` });
      await new Promise((r) => setTimeout(r, 1500));
      const after = await client.call("obsidian_logs", { since: cursor, plugin: PLUGIN });
      assert(new RegExp(PLUGIN).test(after.text), "throw not attributed to the test plugin");
      return "attributed";
    });
  } else {
    console.log("  SKIP plugin checks require PLUGIN_SOURCE_DIR and PLUGIN_ID");
  }

  // -------------------------------------------------------------- error contract
  console.log("\nError contract");
  await check("a bad command yields an actionable error", async () => {
    const { text, isError } = await client.call("obsidian_cli", {
      command: "definitely-not-a-real-command",
    });
    assert(isError, "expected an error result");
    assert(/command|not found|unknown/i.test(text), "error does not identify the bad command");
  });

  await check(
    "an in-page throw is reported as an eval failure, not a transport error",
    async () => {
      const { text, isError } = await client.call("obsidian_eval", {
        code: 'throw new Error("intentional-acceptance-throw")',
      });
      assert(isError, "expected an error result");
      assert(/intentional-acceptance-throw/.test(text), `lost the message: ${text.slice(0, 150)}`);
    },
  );
} finally {
  await client.call("obsidian_close").catch(() => undefined);
  client.close();
  await removeLiveHome(liveHome.home).catch(() => undefined);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
