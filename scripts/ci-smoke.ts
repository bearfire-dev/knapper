/**
 * Degraded-mode smoke test for CI, where Obsidian cannot run.
 *
 * A desktop app is not available on a CI runner, so the live suites cannot run
 * there. What we can still assert — and what actually breaks in practice — is the
 * degraded-mode contract: with nothing to attach to, the server must still start,
 * register its tool surface, answer a status call with a diagnosis instead of a
 * stack trace, and exit when the client goes away.
 *
 * That last point is a regression guard: an attached CDP websocket previously kept
 * the event loop alive and the process lingered after every session.
 *
 *   npx tsx scripts/ci-smoke.ts [path/to/cli.js]
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

type RpcValue = string | number | boolean | null | RpcObject | RpcValue[];
interface RpcObject {
  [key: string]: RpcValue | undefined;
}
interface RpcContent {
  type?: string;
  text?: string;
}
interface RpcTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
}
interface RpcResult {
  serverInfo?: { name?: string; version?: string };
  tools?: RpcTool[];
  content?: RpcContent[];
  isError?: boolean;
}
interface RpcResponse {
  id?: number;
  method?: string;
  result?: RpcResult;
  error?: { message: string };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2] ?? join(root, "dist", "cli.js");
const knapHome = join(root, ".knapper-ci-smoke");
await rm(knapHome, { recursive: true, force: true });

/** A port nothing can be listening on, so attach must fail fast. */
const DEAD_CDP = "http://127.0.0.1:1";
let failed = 0;
function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const child = spawn("node", [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    OBSIDIAN_BIN: "/nonexistent/obsidian",
    OBSIDIAN_CDP_URL: DEAD_CDP,
    KNAP_HOME: knapHome,
  },
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString();
});

const pending = new Map<number, (message: RpcResponse) => void>();
const notifications: string[] = [];
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      continue;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      notifications.push(message.method);
    }
    const resolve = message.id === undefined ? undefined : pending.get(message.id);
    if (resolve) {
      pending.delete(message.id as number);
      resolve(message);
    }
  }
});

let nextId = 1;
function send(method: string, params: RpcObject = {}): Promise<RpcResponse> {
  const id = nextId++;
  const promise = new Promise<RpcResponse>((resolve, reject) => {
    // Clear the guard on settle. An outstanding timer keeps the Node event loop
    // alive, which would otherwise stall this script for the full timeout after
    // its last successful call.
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

console.log(`\nDegraded-mode smoke test: ${entry}\n`);

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ci-smoke", version: "1" },
  });
  check("initialize handshake succeeds", init.result?.serverInfo?.name !== undefined);
  check(
    "server reports a name and version",
    typeof init.result?.serverInfo?.version === "string",
    `${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`,
  );

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await send("tools/list");
  const tools = listed.result?.tools ?? [];
  const names = new Set(tools.map((tool) => tool.name));
  const expected = [
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
  ];
  check("startup surface is fixed at 20 tools", tools.length === 20, `${tools.length} tools`);
  for (const required of expected) {
    check(`${required} is registered`, names.has(required));
  }
  const unexpected = [...names].filter((name) => !expected.includes(name));
  check("startup surface contains no extra tools", unexpected.length === 0, unexpected.join(", "));
  check("no duplicate tool names", names.size === tools.length);
  check(
    "every tool carries a description",
    tools.every((t) => typeof t.description === "string" && t.description.length > 0),
  );
  check(
    "every tool declares whether it is read-only",
    tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean"),
  );

  for (const removed of [
    "obsidian_toolsets",
    "obsidian_tool_catalog",
    "obsidian_session_open",
    "obsidian_session_status",
    "obsidian_session_release",
    "obsidian_session_reset",
    "obsidian_list_targets",
    "obsidian_attach",
  ]) {
    check(`${removed} is absent`, !names.has(removed));
  }

  const status = await send("tools/call", {
    name: "obsidian_status",
    arguments: {},
  });
  const statusText = (status.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("obsidian_status answers instead of crashing", statusText.length > 0);
  check(
    "status diagnoses the missing instance",
    /not running|no|unavailable|disabled/i.test(statusText),
    statusText.split("\n")[0]?.slice(0, 60),
  );

  // A tool that genuinely needs the app must fail as a clean, actionable MCP
  // error rather than a transport-level crash.
  const evaluated = await send("tools/call", {
    name: "obsidian_eval",
    arguments: { code: "1+1" },
  });
  const evalText = (evaluated.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("a call needing the app fails cleanly", evaluated.result?.isError === true);
  check("the failure explains how to fix it", evalText.length > 20, evalText.slice(0, 70));

  const clicked = await send("tools/call", {
    name: "browser_click",
    arguments: { target: ".workspace" },
  });
  const clickText = (clicked.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("browser calls fail cleanly without CDP", clicked.result?.isError === true);
  check("browser failure points to target setup", /obsidian_open/i.test(clickText));

  check(
    "static surface emits no list_changed notification",
    !notifications.includes("notifications/tools/list_changed"),
  );
} catch (e: unknown) {
  check(`smoke sequence completed`, false, e instanceof Error ? e.message : String(e));
}

// Closing stdin is how an MCP client signals shutdown.
child.stdin.end();
const exited = await Promise.race([
  new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0))),
  // unref so a prompt exit is not held up by this watchdog.
  new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000).unref()),
]);
check("process exits when the client closes stdin", exited !== "timeout", `exit=${exited}`);
if (exited === "timeout") child.kill("SIGKILL");
await rm(knapHome, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} check(s) failed.`);
  if (stderr.trim()) console.log(`\nserver stderr:\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log("\nAll degraded-mode checks passed.");
