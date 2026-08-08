/** Single active Obsidian target for handle-free MCP clients. */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { listDescriptors, readDescriptor, type SessionDescriptor } from "../session/descriptor.js";
import {
  createSession,
  listSessions,
  quarantineSession,
  restartSession,
  sessionDiagnostics,
  sessionState,
  stopSession,
  waitSession,
} from "../session/registry.js";
import { UobError } from "../util/errors.js";

function publicSummary(descriptor: SessionDescriptor): Record<string, unknown> {
  return {
    session: descriptor.key,
    phase: descriptor.readiness.phase,
    vault: descriptor.vault?.name,
    plugin: descriptor.plugin?.id,
    pluginSourceDir: descriptor.plugin?.sourceDir,
    cdpUrl: descriptor.instance.cdpUrl,
    pid: descriptor.instance.pid,
    visualIdentity: descriptor.visualIdentity ?? null,
  };
}

function compatible(
  descriptor: SessionDescriptor,
  pluginSourceDir?: string,
  pluginId?: string,
): boolean {
  if (pluginSourceDir !== undefined && descriptor.plugin?.sourceDir !== pluginSourceDir)
    return false;
  if (pluginId !== undefined && descriptor.plugin?.id !== pluginId) return false;
  return true;
}

export function selectSingletonDescriptor(
  descriptors: SessionDescriptor[],
  pluginSourceDir?: string,
  pluginId?: string,
): SessionDescriptor | undefined {
  if (descriptors.length === 0) return undefined;
  const descriptor = descriptors.at(-1) as SessionDescriptor;
  if (!compatible(descriptor, pluginSourceDir, pluginId)) {
    throw new UobError("INVALID_ARGUMENT", "The open Knapper session targets a different plugin.", {
      remediation: "Reset the managed session before you change the plugin target.",
      fixedBy: "obsidian_session_reset",
      details: {
        active: publicSummary(descriptor),
        requested: { pluginSourceDir: pluginSourceDir ?? null, pluginId: pluginId ?? null },
      },
    });
  }
  return descriptor;
}

async function singletonDescriptor(
  pluginSourceDir?: string,
  pluginId?: string,
): Promise<SessionDescriptor | undefined> {
  return selectSingletonDescriptor(await listDescriptors(), pluginSourceDir, pluginId);
}

async function makeReady(
  ctx: ServerContext,
  descriptor: SessionDescriptor,
  timeoutMs?: number,
): Promise<SessionDescriptor> {
  const startedAt = Date.now();
  const remainingOptions = (): { timeoutMs?: number } =>
    timeoutMs === undefined ? {} : { timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)) };
  let next = descriptor;
  if (next.readiness.phase === "starting") {
    next = await waitSession(next.key, remainingOptions());
  } else if (
    next.readiness.phase === "failed" ||
    next.readiness.phase === "stopped" ||
    (await sessionState(next)) !== "live"
  ) {
    const restarted = await restartSession(next.key, {
      logger: ctx.logger.child("session"),
      ...remainingOptions(),
    });
    next = restarted.descriptor;
    if (next.readiness.phase === "starting") {
      next = await waitSession(next.key, remainingOptions());
    }
  }
  await ctx.bindSession(next);
  ctx.selectTelemetry("session");
  return next;
}

async function openIsolated(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<SessionDescriptor> {
  const pluginSourceDir =
    typeof args.pluginSourceDir === "string" ? args.pluginSourceDir : undefined;
  const pluginId = typeof args.pluginId === "string" ? args.pluginId : undefined;
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
  let descriptor = await singletonDescriptor(pluginSourceDir, pluginId);
  if (descriptor === undefined) {
    descriptor = await createSession({
      obsidianBin: ctx.config.obsidianBin,
      logger: ctx.logger.child("session"),
      ...(typeof args.label === "string" ? { label: args.label } : {}),
      ...(pluginSourceDir !== undefined ? { pluginSourceDir } : {}),
      ...(pluginId !== undefined ? { pluginId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  return makeReady(ctx, descriptor, timeoutMs);
}

export function registerSessionTools(ctx: ServerContext): void {
  const { registry } = ctx;

  registry.add({
    name: "obsidian_session_open",
    toolset: "core",
    alwaysEnabled: true,
    targetIndependent: true,
    annotations: { readOnlyHint: false, idempotentHint: true },
    description:
      "Open or reuse the one active Obsidian target. Isolated scratch space is the default.",
    inputSchema: {
      target: z
        .enum(["isolated", "default"])
        .optional()
        .describe("Target type. Omit for a private scratch session."),
      label: z.string().optional().describe("Short label for a new scratch session."),
      pluginSourceDir: z
        .string()
        .optional()
        .describe("Absolute loadable plugin directory with manifest.json and main.js."),
      pluginId: z.string().optional().describe("Expected plugin ID from manifest.json."),
      timeoutMs: z.number().int().positive().optional().describe("Maximum startup wait."),
    },
    handler: async (args) => {
      if (args.target === "default") {
        if (args.pluginSourceDir !== undefined || args.pluginId !== undefined) {
          throw new UobError(
            "INVALID_ARGUMENT",
            "Plugin preloading requires an isolated session.",
            {
              remediation:
                'Omit target="default", or omit pluginSourceDir and pluginId when you open the default profile.',
              fixedBy: "obsidian_session_open",
            },
          );
        }
        await ctx.bindDefault();
        ctx.selectTelemetry("default");
        return {
          text: "The default Obsidian profile is active. Vault authorization still applies.",
          json: { target: "default", active: true },
        };
      }
      const descriptor = await openIsolated(ctx, args);
      return {
        text: `Isolated session ${descriptor.key} is ready.`,
        json: {
          target: "isolated",
          active: true,
          ...publicSummary(descriptor),
          diagnostics: await sessionDiagnostics(descriptor),
        },
      };
    },
  });

  registry.add({
    name: "obsidian_session_status",
    toolset: "core",
    alwaysEnabled: true,
    targetIndependent: true,
    annotations: { readOnlyHint: true },
    description:
      "Report the active target and all legacy managed session records without changing them.",
    inputSchema: {},
    handler: async () => {
      const sessions = await listSessions({ currentKey: ctx.currentSessionKey });
      const active =
        ctx.currentSessionKey === undefined
          ? undefined
          : await readDescriptor(ctx.currentSessionKey);
      return {
        text:
          ctx.targetKind === undefined
            ? `No target is active. ${sessions.length} managed session record(s) exist.`
            : `The active target is ${ctx.targetKind}.`,
        json: {
          target: ctx.targetKind ?? null,
          active: active === undefined ? null : publicSummary(active),
          managedSessions: sessions.map((session) => ({
            ...publicSummary(session.descriptor),
            state: session.state,
            current: session.isCurrent,
          })),
        },
      };
    },
  });

  registry.add({
    name: "obsidian_session_release",
    toolset: "core",
    alwaysEnabled: true,
    targetIndependent: true,
    annotations: { readOnlyHint: false, idempotentHint: true },
    description:
      "Release this server's active target. A private Obsidian session stays open for reuse.",
    inputSchema: {},
    handler: async () => {
      const released = ctx.currentSessionKey;
      await ctx.bindDefault();
      ctx.currentSessionKey = undefined;
      ctx.targetKind = undefined;
      ctx.selectTelemetry("default");
      return {
        text:
          released === undefined
            ? "No active private session needed release."
            : `Released session ${released}.`,
        json: { released: released ?? null, sessionKeptOpen: released !== undefined },
      };
    },
  });

  registry.add({
    name: "obsidian_session_reset",
    toolset: "core",
    alwaysEnabled: true,
    targetIndependent: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Stop and quarantine the managed scratch session, then create a fresh isolated session.",
    inputSchema: {
      label: z.string().optional().describe("Short label for the new scratch session."),
      pluginSourceDir: z
        .string()
        .optional()
        .describe("Absolute loadable plugin directory with manifest.json and main.js."),
      pluginId: z.string().optional().describe("Expected plugin ID from manifest.json."),
      timeoutMs: z.number().int().positive().optional().describe("Maximum stop and startup wait."),
    },
    handler: async (args) => {
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
      const startedAt = Date.now();
      const remainingTimeout = (): number | undefined =>
        timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - startedAt));
      const descriptors = await listDescriptors();
      const previous = ctx.currentSessionKey ?? descriptors.at(-1)?.key;
      let quarantinedPath: string | undefined;
      let archivedTelemetry: string | undefined;
      if (previous !== undefined) {
        const stopTimeout = remainingTimeout();
        const stopped = await stopSession(
          previous,
          stopTimeout !== undefined ? { timeoutMs: stopTimeout } : {},
        );
        if (stopped.state === "quitFailed") {
          throw new UobError("TIMEOUT", `Session ${previous} did not stop.`, {
            remediation: "Retry after the managed Obsidian process stops.",
          });
        }
        quarantinedPath = (await quarantineSession(previous)).quarantinedPath;
      }
      await ctx.bindDefault();
      ctx.currentSessionKey = undefined;
      ctx.targetKind = undefined;
      ctx.selectTelemetry("default");
      if (quarantinedPath !== undefined) {
        archivedTelemetry = await ctx.archiveTelemetry("session", quarantinedPath);
      }
      const nextTimeout = remainingTimeout();
      const descriptor = await openIsolated(ctx, {
        ...args,
        ...(nextTimeout !== undefined ? { timeoutMs: nextTimeout } : {}),
      });
      return {
        text: `Fresh isolated session ${descriptor.key} is ready.`,
        json: {
          reset: previous ?? null,
          quarantinedPath: quarantinedPath ?? null,
          archivedTelemetry: archivedTelemetry ?? null,
          ...publicSummary(descriptor),
        },
      };
    },
  });
}
