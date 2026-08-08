/**
 * Live singleton-activity suite.
 *
 * Knapper owns one managed Obsidian session. A second stdio client must observe
 * that activity, receive KNAPPER_BUSY for mutations, and take over after release.
 *
 *   npm run workspaces
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDisposableWorkspace, createLiveHome, removeLiveHome } from "./lib/live-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

class McpClient {
  constructor(env, name) {
    this.child = spawn("node", [CLI, "--toolsets", "all", "--log-level", "error"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.name = name;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.stderr.on("data", (chunk) => {
      if (process.env.VERBOSE) process.stderr.write(`[${name}] ${chunk}`);
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 45_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    const result = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: this.name, version: "1" },
    });
    this.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return result;
  }

  async call(name, args = {}) {
    const result = await this.send("tools/call", { name, arguments: args });
    if (result.error) throw new Error(result.error.message);
    const content = result.result?.content ?? [];
    return {
      text: content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
      json: result.result?.structuredContent,
      isError: result.result?.isError === true,
    };
  }

  close() {
    this.child.stdin.end();
  }
}

const liveHome = await createLiveHome("knapper-singleton-");
const env = liveHome.env;
const first = new McpClient(env, "singleton-a");
const second = new McpClient(env, "singleton-b");
try {
  await first.initialize();
  await second.initialize();
  const opened = await createDisposableWorkspace(first, ROOT, {
    home: liveHome.home,
    label: "singleton-scratch",
  });
  check("first client opens one isolated session", typeof opened.sessionKey === "string");

  const status = await second.call("obsidian_status");
  check("second client observes busy activity", /Agent use: busy/.test(status.text), status.text);

  const blocked = await second.call("obsidian_create", {
    path: "should-not-exist.md",
    content: "busy\n",
  });
  check(
    "second client receives KNAPPER_BUSY",
    blocked.isError && blocked.json?.code === "KNAPPER_BUSY",
    blocked.text,
  );

  const released = await first.call("obsidian_session_release");
  check(
    "first client releases its session",
    !released.isError && released.json?.released,
    released.text,
  );
  const takeover = await second.call("obsidian_session_open", { target: "isolated" });
  check("release permits takeover", !takeover.isError, takeover.text);
  check("takeover reuses the same session", takeover.json?.session === opened.sessionKey);

  const sessionStatus = await second.call("obsidian_session_status");
  const sessions = sessionStatus.json?.managedSessions;
  check("only one managed session is reported", sessions?.length === 1);
  await second.call("obsidian_session_release").catch(() => undefined);
} finally {
  first.close();
  second.close();
  await removeLiveHome(liveHome.home).catch(() => undefined);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
