/**
 * MCP server assembly: build the router, register every enabled toolset, and
 * expose a single `createServer` used by both the CLI entry point and tests.
 */

import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import {
  cliIsolationFor,
  knapperHome,
  loadConfig,
  obsidianConfigPath,
  type Config,
} from "./config.js";
import { CapabilityRouter } from "./connection/router.js";
import { ToolRegistry } from "./tools/registry.js";
import { createLogger, type Logger } from "./util/logger.js";
import { TOOLSET_DESCRIPTIONS } from "./toolsets.js";
import { registerCoreTools } from "./tools/core.js";
import { registerProvisioningTools } from "./tools/provisioning.js";
import { registerSessionTools } from "./tools/session.js";
import { registerObsidianTools } from "./tools/obsidian.js";
import { registerEditorTools } from "./tools/editor.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerAuthoringTools } from "./tools/authoring.js";
import { registerDevtoolsTools } from "./tools/devtools.js";
import { registerTelemetryTools } from "./tools/telemetry.js";
import { registerPluginDevTools } from "./tools/plugin-dev.js";
import { registerBrowserTools } from "./tools/browser.js";
import { TelemetryStore } from "./telemetry/store.js";
import { WorkspaceTelemetryStore } from "./telemetry/workspace-store.js";
import { TelemetryCapture } from "./telemetry/capture.js";
import { BrowserProxy } from "./browser/proxy.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  listDescriptors,
  patchDescriptor,
  readDescriptor,
  type SessionDescriptor,
} from "./session/descriptor.js";
import { readPidStartTime } from "./connection/health.js";
import { reapStaleSessions } from "./session/reap.js";
import { sessionState, waitSession } from "./session/registry.js";
import type { ToolRequestContext } from "./audit/types.js";
import { UobError } from "./util/errors.js";
import { recoverVaultTransaction } from "./connection/vault-transaction.js";
import { vaultAuthorizationRegistryPath } from "./connection/vaults.js";
import { ActivityGuard } from "./usage/activity-guard.js";

export interface ServerContext {
  config: Config;
  logger: Logger;
  router: CapabilityRouter;
  telemetry: TelemetryStore;
  capture: TelemetryCapture;
  browserProxy: BrowserProxy;
  registry: ToolRegistry;
  activity: ActivityGuard;
  currentSessionKey?: string;
  targetKind?: "isolated" | "default";
  clientInfo(): { name: string; version: string; title?: string } | undefined;
  protocolVersion(): string | undefined;
  bindSession(descriptor: SessionDescriptor): Promise<void>;
  bindDefault(): Promise<void>;
  selectTelemetry(scope: "default" | "session"): void;
  archiveTelemetry(scope: "session", destinationRoot: string): Promise<string | undefined>;
  stopJanitor(): void;
}

/** Apply one ready session descriptor to the shared runtime configuration. */
export function applySessionConfig(config: Config, descriptor: SessionDescriptor): void {
  delete config.targetMatch;
  if (descriptor.readiness.phase !== "ready" || descriptor.instance.cdpUrl === undefined) {
    throw new Error(`Session ${descriptor.key} is not ready for binding.`);
  }
  const url = new URL(descriptor.instance.cdpUrl);
  config.sessionId = descriptor.key;
  config.cdpUrl = descriptor.instance.cdpUrl;
  config.cdpPort = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  config.userDataDir = descriptor.instance.userDataDir;
  config.obsidianConfigPath = obsidianConfigPath(descriptor.instance.userDataDir);
  config.outputDir = descriptor.instance.outputDir;
  config.vault = descriptor.vault?.name;
  config.cliIsolation = cliIsolationFor(descriptor.instance.runtimeDir);
  if (descriptor.instance.runtimeDir !== undefined)
    config.runtimeDir = descriptor.instance.runtimeDir;
  else delete config.runtimeDir;
}

function copyConfig(config: Config): Config {
  return { ...config, enabledToolsets: new Set(config.enabledToolsets) };
}

function restoreConfig(target: Config, source: Config): void {
  delete target.sessionId;
  delete target.runtimeDir;
  delete target.vault;
  delete target.targetMatch;
  Object.assign(target, copyConfig(source));
}

function observedClient(
  requestContext?: ToolRequestContext,
): { name: string; version: string; title?: string } | undefined {
  const raw = requestContext?.clientInfo ?? requestContext?.mcpReq?.envelope?.clientInfo;
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = raw as Record<string, unknown>;
  if (typeof info.name !== "string") return undefined;
  return {
    name: info.name,
    version: typeof info.version === "string" ? info.version : "unknown",
    ...(typeof info.title === "string" ? { title: info.title } : {}),
  };
}

async function packageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = await readFile(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Instructions surfaced to the client at initialization. Codex reads this field and
 * advises keeping the first 512 characters self-contained, so the essentials come
 * first and the detail follows.
 */
/**
 * Shown to the agent at initialize. It has to answer "should I reach for this?"
 * before it answers "how do I drive it?", because an agent that does not connect
 * a request to this server never reads the second half.
 */
const INSTRUCTIONS = `knapper drives a **live Obsidian desktop application** (the Markdown note-taking app by Dynalist) over MCP. It automates the real running app on this machine — not a copy of the vault on disk, and not a web service.

USE THIS SERVER WHEN the task involves:
- Developing, building, reloading, or testing an **Obsidian plugin** or theme — this is its primary purpose. obsidian_dev_cycle answers "did my plugin change work?" in one call.
- Reading, creating, editing, moving, or searching notes in an **Obsidian vault**.
- Driving the Obsidian **UI**: clicking, typing, opening the command palette, screenshotting, inspecting the DOM or accessibility tree.
- Reading Obsidian's **console output, errors, or plugin stack traces**.
- Anything phrased as "in Obsidian", "my vault", "my notes", "this plugin", when Obsidian is the app in question.

DO NOT USE IT FOR: general web browsing or automating other websites (the browser_* tools here are bound to the Obsidian window), editing this project's own source files, or reading Markdown that merely happens to live outside a vault — ordinary file tools are better for that.

GETTING STARTED: call obsidian_session_open for an isolated scratch session. Use target="default" only when the user explicitly wants their own Obsidian profile. Operational tools use the active session automatically and never require a handle.

CONCURRENCY: Knapper controls one Obsidian target and runs one operation at a time. obsidian_status reports whether another Knapper process used the target recently.

SAFETY: isolated sessions always use Knapper-owned scratch vaults. obsidian_session_reset stops the managed instance and moves its verified root to recoverable Knapper trash. Cleanup never deletes a user vault. Existing vault access needs an external authorization that the user creates from a terminal. Knapper never treats an Obsidian registry entry or a file inside a vault as deletion authority.

TASK INDEX: select a target with obsidian_session_open; diagnose setup with obsidian_doctor; inspect transports with obsidian_capabilities; reload a plugin with obsidian_dev_cycle; inspect UI with obsidian_snapshot; read new errors with obsidian_logs.

CONVENTIONS: use obsidian_* tools for app, vault, and plugin state; browser_* tools for real input. Browser tools are snapshot-first — call browser_snapshot (or the cheaper obsidian_snapshot), then pass a returned ref as "target"; a CSS selector also works. Prefer obsidian_command over clicking through menus. Read console output with obsidian_logs, passing the previous call's cursor as "since" to see only what is new.`;

export async function createServerContext(config: Config): Promise<ServerContext> {
  const logger = createLogger(config.logLevel);
  const baseConfig = copyConfig(config);
  if (baseConfig.sessionId !== undefined) {
    const unbound = loadConfig({}, process.env);
    baseConfig.cdpUrl = unbound.cdpUrl;
    baseConfig.cdpPort = unbound.cdpPort;
    baseConfig.userDataDir = unbound.userDataDir;
    baseConfig.obsidianConfigPath = unbound.obsidianConfigPath;
    baseConfig.outputDir = unbound.outputDir;
    baseConfig.cliIsolation = unbound.cliIsolation;
    delete baseConfig.sessionId;
    delete baseConfig.runtimeDir;
  }

  if (config.unknownToolsets.length > 0) {
    logger.warn(`ignoring unknown toolset name(s): ${config.unknownToolsets.join(", ")}`, {
      valid: Object.keys(TOOLSET_DESCRIPTIONS),
    });
  }

  const router = new CapabilityRouter(config, logger);
  const telemetry = new WorkspaceTelemetryStore(
    config.telemetryBuffer,
    join(knapperHome(), "telemetry"),
  );
  const capture = new TelemetryCapture(
    router,
    telemetry,
    logger.child("telemetry"),
    config.telemetryNetwork,
  );
  const browserProxy = new BrowserProxy(config, router, logger.child("browser"));
  const activity = new ActivityGuard({
    idleTimeoutMs: config.activityIdleMs,
    onError: (error) =>
      logger.warn("activity ownership update failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  let ctx!: ServerContext;
  const managedSessionOpen = async (): Promise<boolean> => {
    const descriptors = await listDescriptors();
    const states = await Promise.all(descriptors.map((descriptor) => sessionState(descriptor)));
    return states.includes("live");
  };
  const statusOnlyTools = new Set([
    "obsidian_status",
    "obsidian_doctor",
    "obsidian_session_status",
    "obsidian_capabilities",
    "obsidian_toolsets",
    "obsidian_tool_catalog",
  ]);
  const registry = new ToolRegistry(config.enabledToolsets, logger, telemetry, {
    beforeInvoke: async (definition) => {
      if (!statusOnlyTools.has(definition.name)) {
        await activity.acquire({
          operation: definition.name,
          sessionOpen: await managedSessionOpen(),
        });
      }
      if (definition.targetIndependent === true) return;
      if (ctx.targetKind === undefined) {
        throw new UobError("SESSION_NOT_FOUND", "No Obsidian session is active.", {
          remediation: "Open an isolated session before you use operational tools.",
          fixedBy: "obsidian_session_open",
        });
      }
      if (ctx.targetKind === "isolated") {
        if (ctx.currentSessionKey === undefined) {
          throw new UobError("SESSION_NOT_FOUND", "The active session has no descriptor.", {
            remediation: "Open a new isolated session.",
            fixedBy: "obsidian_session_open",
          });
        }
        let descriptor = await readDescriptor(ctx.currentSessionKey);
        if (descriptor === undefined) {
          throw new UobError(
            "SESSION_NOT_FOUND",
            `Session ${ctx.currentSessionKey} no longer has a descriptor.`,
            { remediation: "Open a new isolated session.", fixedBy: "obsidian_session_open" },
          );
        }
        if (descriptor.readiness.phase === "starting") {
          descriptor = await waitSession(descriptor.key);
        }
        if (config.sessionId !== descriptor.key) await ctx.bindSession(descriptor);
        telemetry.select("session");
      } else {
        telemetry.select("default");
      }
    },
    contextProvider: async (_args, requestContext) => {
      const clientInfo =
        observedClient(requestContext) ??
        (config.transport === "stdio" ? ctx.clientInfo() : undefined);
      const rawProtocolVersion =
        requestContext?.protocolVersion ?? requestContext?.mcpReq?.envelope?.protocolVersion;
      const protocolVersion =
        typeof rawProtocolVersion === "string"
          ? rawProtocolVersion
          : config.transport === "stdio"
            ? ctx.protocolVersion()
            : undefined;
      return {
        ...(clientInfo !== undefined ? { clientInfo } : {}),
        transport: config.transport,
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
        ...(requestContext?.requestId !== undefined || requestContext?.mcpReq?.id !== undefined
          ? {
              traceId: String(requestContext.requestId ?? requestContext?.mcpReq?.id),
            }
          : {}),
        ...(ctx.targetKind !== undefined ? { workspaceKind: ctx.targetKind } : {}),
      };
    },
    afterInvoke: async (definition, _args, _requestContext, outcome) => {
      if (statusOnlyTools.has(definition.name)) return;
      const releaseSucceeded =
        definition.name === "obsidian_session_release" && !(outcome instanceof UobError);
      await activity.complete(releaseSucceeded ? false : await managedSessionOpen());
      if (releaseSucceeded) await activity.release();
    },
  });

  let janitorTimer: NodeJS.Timeout | undefined;
  const runJanitor = (): void => {
    void recoverVaultTransaction(
      baseConfig.obsidianConfigPath,
      vaultAuthorizationRegistryPath(),
      process.env,
    )
      .then(() =>
        reapStaleSessions({
          deleteVaults: true,
          idleTimeoutMs: config.idleTimeoutMs,
          ...(ctx.currentSessionKey !== undefined ? { keep: ctx.currentSessionKey } : {}),
          logger: logger.child("janitor"),
        }),
      )
      .catch((error) => logger.debug("session janitor skipped", { error: String(error) }));
  };

  ctx = {
    config,
    logger,
    router,
    telemetry,
    capture,
    browserProxy,
    registry,
    activity,
    currentSessionKey: undefined,
    targetKind: undefined,
    clientInfo: () => undefined,
    protocolVersion: () => undefined,
    bindSession: async (descriptor) => {
      await browserProxy.close();
      capture.reset();
      applySessionConfig(config, descriptor);
      await router.rebind();
      const ownerStartedAt = new Date().toISOString();
      const ownerPidStartTime = await readPidStartTime(process.pid);
      await patchDescriptor(descriptor.key, (current) => ({
        ...current,
        heartbeatAt: ownerStartedAt,
        owner: {
          pid: process.pid,
          ...(ownerPidStartTime !== undefined ? { pidStartTime: ownerPidStartTime } : {}),
          startedAt: ownerStartedAt,
        },
      }));
      ctx.currentSessionKey = descriptor.key;
      ctx.targetKind = "isolated";
    },
    bindDefault: async () => {
      await browserProxy.close();
      capture.reset();
      restoreConfig(config, baseConfig);
      await router.rebind();
      ctx.currentSessionKey = undefined;
      ctx.targetKind = "default";
    },
    selectTelemetry: (scope) => telemetry.select(scope),
    archiveTelemetry: (scope, destinationRoot) => telemetry.archive(scope, destinationRoot),
    stopJanitor: () => {
      if (janitorTimer !== undefined) clearInterval(janitorTimer);
      janitorTimer = undefined;
    },
  };

  runJanitor();
  janitorTimer = setInterval(runJanitor, 60_000);
  janitorTimer.unref();

  registerCoreTools(ctx);
  registerProvisioningTools(ctx);
  registerSessionTools(ctx);
  registerObsidianTools(ctx);
  registerEditorTools(ctx);
  registerVaultTools(ctx);
  registerAuthoringTools(ctx);
  registerDevtoolsTools(ctx);
  registerTelemetryTools(ctx);
  registerPluginDevTools(ctx);
  await registerBrowserTools(ctx);

  // Starts detached and stays quiet until Obsidian appears; stopped by
  // `router.dispose()`, which the CLI already calls on shutdown.
  router.supervisor.start();

  return ctx;
}

export async function createServer(config: Config): Promise<{
  server: McpServer;
  factory: McpServerFactory;
  ctx: ServerContext;
}> {
  const ctx = await createServerContext(config);
  const version = await packageVersion();
  let latestServer: McpServer | undefined;
  const buildServer = (): McpServer => {
    const next = new McpServer({ name: "knapper", version }, { instructions: INSTRUCTIONS });
    ctx.registry.bind(next);
    latestServer = next;
    return next;
  };
  const factory: McpServerFactory = () => buildServer();
  const server = buildServer();
  ctx.clientInfo = () => {
    const info = latestServer?.server.getClientVersion();
    return info === undefined
      ? undefined
      : {
          name: info.name,
          version: info.version,
          ...(info.title !== undefined ? { title: info.title } : {}),
        };
  };
  ctx.protocolVersion = () => latestServer?.server.getNegotiatedProtocolVersion();

  return { server, factory, ctx };
}
