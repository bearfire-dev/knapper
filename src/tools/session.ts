/** Open and close the one private Obsidian development target. */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import { listDescriptors, type SessionDescriptor } from "../session/descriptor.js";
import { prepareDevelopmentPaths } from "../session/dev-vault.js";
import {
  createSession,
  releaseSession,
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
    vaultPath: descriptor.vault?.path,
    pluginId: descriptor.plugin?.id,
    pluginDir: descriptor.plugin?.sourceDir,
    pid: descriptor.instance.pid,
    visualIdentity: descriptor.visualIdentity ?? null,
  };
}

function compatible(descriptor: SessionDescriptor, pluginDir?: string): boolean {
  return pluginDir === undefined || descriptor.plugin?.sourceDir === pluginDir;
}

export function selectSingletonDescriptor(
  descriptors: SessionDescriptor[],
  pluginDir?: string,
  pluginId?: string,
): SessionDescriptor | undefined {
  if (descriptors.length === 0) return undefined;
  const descriptor = descriptors.at(-1) as SessionDescriptor;
  if (
    !compatible(descriptor, pluginDir) ||
    (pluginId !== undefined && descriptor.plugin?.id !== pluginId)
  ) {
    throw new UobError("INVALID_ARGUMENT", "The open Knapper session targets a different plugin.", {
      remediation: "Close the active session before you change the plugin target.",
      fixedBy: "obsidian_close",
      details: {
        active: publicSummary(descriptor),
        requested: { pluginDir: pluginDir ?? null, pluginId: pluginId ?? null },
      },
    });
  }
  return descriptor;
}

async function makeReady(
  ctx: ServerContext,
  descriptor: SessionDescriptor,
): Promise<SessionDescriptor> {
  let next = descriptor;
  if (next.readiness.phase === "starting") {
    next = await waitSession(next.key);
  } else if (
    next.readiness.phase === "failed" ||
    next.readiness.phase === "stopped" ||
    (await sessionState(next)) !== "live"
  ) {
    const restarted = await restartSession(next.key, {
      logger: ctx.logger.child("session"),
    });
    next = restarted.descriptor;
    if (next.readiness.phase === "starting") next = await waitSession(next.key);
  }
  await ctx.bindSession(next);
  ctx.selectTelemetry("session");
  return next;
}

async function openDevelopmentTarget(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<SessionDescriptor> {
  const requested = await prepareDevelopmentPaths(
    String(args.vaultPath),
    typeof args.pluginDir === "string" ? args.pluginDir : undefined,
  );
  const descriptors = await listDescriptors();
  const matching: SessionDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.vault?.path === undefined) continue;
    const candidatePath = await realpath(resolve(descriptor.vault.path)).catch(() => undefined);
    if (candidatePath === requested.vaultPath) matching.push(descriptor);
  }

  let descriptor = matching.at(-1);
  if (descriptor !== undefined && !compatible(descriptor, requested.pluginDir)) {
    throw new UobError("INVALID_ARGUMENT", "The open Knapper session targets a different plugin.", {
      remediation: "Close the active session before you change the plugin target.",
      fixedBy: "obsidian_close",
      details: {
        active: publicSummary(descriptor),
        requested: { pluginDir: requested.pluginDir ?? null },
      },
    });
  }

  if (descriptor === undefined) {
    const live = (
      await Promise.all(
        descriptors.map(async (candidate) => ({
          candidate,
          state: await sessionState(candidate),
        })),
      )
    ).find(({ state }) => state === "live")?.candidate;
    if (live !== undefined) {
      throw new UobError(
        "INVALID_ARGUMENT",
        "Knapper already has a different Obsidian vault open.",
        {
          remediation: "Call obsidian_close before you open another vault.",
          fixedBy: "obsidian_close",
          details: { active: publicSummary(live), requested: requested.vaultPath },
        },
      );
    }
    descriptor = await createSession({
      obsidianBin: ctx.config.obsidianBin,
      logger: ctx.logger.child("session"),
      vaultPath: requested.vaultPath,
      ...(requested.pluginDir !== undefined ? { pluginSourceDir: requested.pluginDir } : {}),
    });
  }
  return makeReady(ctx, descriptor);
}

export function registerSessionTools(ctx: ServerContext): void {
  const { registry } = ctx;

  registry.add({
    name: "obsidian_open",
    toolset: "core",
    alwaysEnabled: true,
    targetIndependent: true,
    annotations: { readOnlyHint: false, idempotentHint: true },
    description: "Open or reuse one private Obsidian profile for a Git-ignored development vault.",
    inputSchema: {
      vaultPath: z
        .string()
        .describe("Absolute vault path below the plugin Git root. Git must ignore this path."),
      pluginDir: z
        .string()
        .optional()
        .describe("Absolute directory for the one plugin to link and load."),
    },
    handler: async (args) => {
      const descriptor = await openDevelopmentTarget(ctx, args);
      return {
        text: `Obsidian is ready for ${descriptor.vault?.path}.`,
        json: {
          active: true,
          ...publicSummary(descriptor),
          diagnostics: await sessionDiagnostics(descriptor),
        },
      };
    },
  });

  registry.add({
    name: "obsidian_close",
    toolset: "core",
    alwaysEnabled: true,
    targetIndependent: true,
    annotations: { readOnlyHint: false, idempotentHint: true },
    description:
      "Close the private Obsidian profile and unlink its plugin. The development vault stays intact.",
    inputSchema: {},
    handler: async () => {
      const released = ctx.currentSessionKey;
      let vaultPath: string | undefined;
      if (released !== undefined) {
        const descriptor = (await listDescriptors()).find(
          (candidate) => candidate.key === released,
        );
        vaultPath = descriptor?.vault?.path;
        const stopped = await stopSession(released);
        if (stopped.state === "quitFailed") {
          throw new UobError("TIMEOUT", `Session ${released} did not stop.`, {
            remediation: "Retry after the private Obsidian process stops.",
          });
        }
        await releaseSession(released);
      }
      await ctx.bindDefault();
      ctx.currentSessionKey = undefined;
      ctx.targetKind = undefined;
      ctx.selectTelemetry("default");
      return {
        text:
          released === undefined
            ? "No private Obsidian profile was open."
            : `Closed Obsidian. The vault remains at ${vaultPath}.`,
        json: { closed: released ?? null, vaultPath: vaultPath ?? null, vaultKept: true },
      };
    },
  });
}
