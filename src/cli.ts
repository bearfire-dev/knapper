#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, defaultObsidianBin, TRANSPORT_KINDS } from "./config.js";
import { createServer } from "./server.js";
import { startHttpTransport, type HttpTransportHandle } from "./transport/http.js";
import { LOG_LEVELS } from "./util/logger.js";
import { fileURLToPath } from "node:url";
import { openCodeMcpConfig } from "./config-output.js";

/**
 * Subcommands, with the server as the default command.
 *
 * `knapper` with no verb starts the MCP server. The only subcommand prints host
 * configuration. Vault selection belongs to obsidian_open, not process flags.
 */
const argv = await yargs(hideBin(process.argv))
  .scriptName("knapper")
  .usage("$0 [options]\n\nMCP server for Obsidian plugin development.")
  .command(
    "config <host>",
    "Print a host configuration that uses this exact Knapper installation",
    (y) =>
      y.positional("host", {
        type: "string",
        choices: ["opencode"],
        describe: "Host configuration format",
      }),
    async () => {
      process.stdout.write(
        `${JSON.stringify(
          openCodeMcpConfig({
            nodePath: process.execPath,
            entryPath: fileURLToPath(import.meta.url),
          }),
          null,
          2,
        )}\n`,
      );
      process.exit(0);
    },
  )
  .option("obsidian-bin", {
    type: "string",
    describe: `Path to the Obsidian binary (default: ${defaultObsidianBin()})`,
  })
  .option("log-level", {
    type: "string",
    choices: LOG_LEVELS as unknown as string[],
    describe: "Log verbosity (stderr only)",
  })
  .option("output-dir", {
    type: "string",
    describe: "Directory for screenshots and snapshot files",
  })
  .option("transport", {
    type: "string",
    choices: TRANSPORT_KINDS as unknown as string[],
    describe: "MCP transport to serve (default: stdio)",
  })
  .option("port", {
    type: "number",
    describe: "Listen port for the http transport (default: 9223)",
  })
  .option("host", {
    type: "string",
    describe: "Listen host for the http transport (default: 127.0.0.1)",
  })
  .example("$0 config opencode", "Print an OpenCode MCP configuration")
  .strictOptions()
  .help()
  .version(false)
  .parseAsync();

// A subcommand handler calls process.exit, so reaching here means the default
// command: start the server.

const config = loadConfig({
  ...(argv["obsidian-bin"] !== undefined ? { obsidianBin: argv["obsidian-bin"] } : {}),
  ...(argv["log-level"] !== undefined ? { logLevel: argv["log-level"] } : {}),
  ...(argv["output-dir"] !== undefined ? { outputDir: argv["output-dir"] } : {}),
  ...(argv.transport !== undefined ? { transport: argv.transport } : {}),
  ...(argv.port !== undefined ? { httpPort: argv.port } : {}),
  ...(argv.host !== undefined ? { httpHost: argv.host } : {}),
});

const { factory, ctx } = await createServer(config);

let httpHandle: HttpTransportHandle | undefined;
let stdioHandle: StdioServerHandle | undefined;

let shuttingDown = false;
const shutdown = async (reason: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  ctx.logger.info(`${reason}, shutting down`);
  // Record that this server is gone, but deliberately do NOT close the session:
  // an MCP client restarting must not destroy the agent's Obsidian and vault. The
  // reaper collects it later if nobody comes back for it.
  if (config.sessionId !== undefined) {
    const { patchDescriptor } = await import("./session/descriptor.js");
    await patchDescriptor(config.sessionId, (d) =>
      d.owner?.pid === process.pid
        ? {
            ...d,
            heartbeatAt: new Date().toISOString(),
            owner: { ...d.owner, exitedAt: new Date().toISOString() },
          }
        : d,
    ).catch(() => undefined);
  }
  await httpHandle?.close().catch(() => undefined);
  await stdioHandle?.close().catch(() => undefined);
  ctx.stopJanitor();
  await ctx.browserProxy.close().catch(() => undefined);
  await ctx.router.dispose().catch(() => undefined);
  ctx.telemetry.closePersistence();
  await ctx.activity.release().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("received SIGINT"));
process.on("SIGTERM", () => void shutdown("received SIGTERM"));

if (config.transport === "http") {
  // Deliberately no stdin hooks here: under http the client is not on the other end of
  // this process's stdin, and a detached or redirected stdin closing must not take a
  // server with live sessions down with it.
  httpHandle = await startHttpTransport({
    factory,
    config,
    logger: ctx.logger,
  });
  ctx.logger.info(`knapper listening on ${httpHandle.url}`, {
    cdpUrl: config.cdpUrl,
  });
} else {
  // An MCP client signals shutdown by closing stdin. Without this the attached CDP
  // websocket keeps the event loop alive and the process lingers after every session.
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.stdin.on("end", () => void shutdown("stdin ended"));

  stdioHandle = serveStdio(factory, {
    legacy: "serve",
    onerror: (error) => ctx.logger.error("stdio transport failed", { error: error.message }),
  });
  ctx.logger.info("knapper ready", {
    cdpUrl: config.cdpUrl,
    ...(config.sessionId !== undefined ? { session: config.sessionId } : {}),
  });
}
