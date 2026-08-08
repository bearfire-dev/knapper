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
 *   node scripts/ci-smoke.mjs [path/to/cli.js]
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2] ?? join(root, "dist", "cli.js");
const knapHome = join(root, ".knapper-ci-smoke");
await rm(knapHome, { recursive: true, force: true });

/** A port nothing can be listening on, so attach must fail fast. */
const DEAD_CDP = "http://127.0.0.1:1";
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const child = spawn("node", [entry, "--cdp-url", DEAD_CDP], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OBSIDIAN_BIN: "/nonexistent/obsidian", KNAP_HOME: knapHome },
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString();
});

const pending = new Map();
const notifications = [];
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      notifications.push(message.method);
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
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
  check("startup surface contains operational tools", tools.length > 60, `${tools.length} tools`);
  for (const required of [
    "obsidian_status",
    "obsidian_doctor",
    "obsidian_capabilities",
    "obsidian_session_open",
    "obsidian_session_status",
    "obsidian_session_release",
    "obsidian_session_reset",
    "browser_snapshot",
    "browser_click",
    "obsidian_plugin_health",
    "obsidian_dev_cycle",
  ]) {
    check(`${required} is registered`, names.has(required));
  }
  check("no duplicate tool names", names.size === tools.length);
  check(
    "every tool carries a description",
    tools.every((t) => typeof t.description === "string" && t.description.length > 0),
  );
  check(
    "every tool declares whether it is read-only",
    tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean"),
  );

  check("legacy dynamic tool update is absent", !names.has("obsidian_toolsets_update"));
  check("legacy agent handles are absent", !names.has("obsidian_agent_open"));
  check("legacy workspace handles are absent", !names.has("obsidian_workspace_claim_default"));

  const session = await send("tools/call", {
    name: "obsidian_session_status",
    arguments: {},
  });
  check("session status answers without a handle", session.result?.isError !== true);

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

  const doctor = await send("tools/call", {
    name: "obsidian_doctor",
    arguments: {},
  });
  const doctorText = (doctor.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("obsidian_doctor answers while offline", doctor.result?.isError !== true);
  check(
    "offline doctor reports the unavailable automation transport",
    /not running|stopped|CDP reachable: no/i.test(doctorText),
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
  check("browser failure points to session setup", /obsidian_session_open/i.test(clickText));

  check(
    "static surface emits no list_changed notification",
    !notifications.includes("notifications/tools/list_changed"),
  );
} catch (e) {
  check(`smoke sequence completed`, false, e.message);
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
