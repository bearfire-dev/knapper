import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Create a private Knapper home. The server then launches its own profile and CDP port. */
export async function createLiveHome(prefix = "knapper-live-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  return { home, env: { ...process.env, KNAP_HOME: home } };
}

/** Open the one active isolated session and prove its vault is Knapper-owned. */
export async function createDisposableWorkspace(client, _root, options = {}) {
  const args = { target: "isolated", label: options.label ?? "isolated-live" };
  if (options.pluginSourceDir !== undefined) args.pluginSourceDir = options.pluginSourceDir;
  if (options.pluginId !== undefined) args.pluginId = options.pluginId;
  const created = await client.call("obsidian_session_open", args);
  const sessionKey = created.json?.session;
  if (typeof sessionKey !== "string") throw new Error(`session open failed: ${created.text}`);
  const home = options.home ?? process.env.KNAP_HOME;
  if (!home) throw new Error("KNAP_HOME is required for isolated live suites");
  const session = JSON.parse(
    await readFile(join(home, "sessions", sessionKey, "session.json"), "utf8"),
  );
  const vaultPath = resolve(session.ownership?.vaultPath ?? "");
  const ownedRoot = resolve(home);
  if (!session.ownership || !vaultPath.startsWith(`${ownedRoot}/`)) {
    throw new Error(`session ${sessionKey} is not a Knapper-owned scratch vault`);
  }
  await stat(vaultPath);
  return { sessionKey, vaultPath, session };
}

export async function removeLiveHome(home) {
  const target = home ? resolve(home) : "";
  const tempRoot = resolve(tmpdir());
  if (!home || !target.startsWith(`${tempRoot}${sep}`)) {
    throw new Error(`refusing to remove non-temporary KNAP_HOME: ${home}`);
  }
  const env = { ...process.env, KNAP_HOME: home };
  const { quarantineSession, stopSession } = await import("../../dist/session/registry.js");
  const { readDescriptor } = await import("../../dist/session/descriptor.js");
  const keys = await readdir(join(home, "sessions")).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const key of keys) {
    if ((await readDescriptor(key, env)) === undefined) continue;
    const stopped = await stopSession(key, { env });
    if (stopped.state === "quitFailed") {
      throw new Error(`refusing to remove ${home}: Obsidian for ${key} did not stop`);
    }
    await quarantineSession(key, { env });
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt === 9) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

export async function findFreePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}
