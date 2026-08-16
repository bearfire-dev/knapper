import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LIVE_VAULTS_FILE = "live-vaults.json";

export interface LiveCallResult {
  text: string;
  json?: unknown;
  isError: boolean;
  raw?: unknown;
}

export interface LiveClient {
  call(name: string, args?: Record<string, unknown>): Promise<LiveCallResult>;
}

export interface LiveWorkspaceOptions {
  home?: string;
  label?: string;
  pluginSourceDir?: string;
  pluginId?: string;
  agentLabel?: string;
}

export interface LiveSessionDescriptor {
  key: string;
  vault?: { name?: string; path?: string; grant?: "created" | "adopted" };
  ownership?: { vaultPath?: string };
  instance: { userDataDir: string };
}

export interface DisposableWorkspace {
  sessionKey: string;
  vaultPath: string;
  session: LiveSessionDescriptor;
}

/** Create a private Knapper home. The server then launches its own profile and CDP port. */
export async function createLiveHome(prefix = "knapper-live-"): Promise<{
  home: string;
  env: NodeJS.ProcessEnv;
}> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  return { home, env: { ...process.env, KNAP_HOME: home } };
}

/** Open one Git-ignored development vault in a private Obsidian profile. */
export async function createDisposableWorkspace(
  client: LiveClient,
  root: string,
  options: LiveWorkspaceOptions = {},
): Promise<DisposableWorkspace> {
  const home = options.home ?? process.env.KNAP_HOME;
  if (!home) throw new Error("KNAP_HOME is required for live suites");
  const repositoryBase = options.pluginSourceDir ?? root;
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: repositoryBase,
    encoding: "utf8",
  });
  const repositoryRoot = resolve(stdout.trim());
  const vaultPath = join(
    repositoryRoot,
    ".knapper",
    `live-${basename(home)}-${options.label ?? "isolated"}`,
  );
  await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", `${vaultPath}/`], {
    cwd: repositoryRoot,
  });
  await mkdir(vaultPath, { recursive: true, mode: 0o700 });
  const trackedPath = join(home, LIVE_VAULTS_FILE);
  const tracked = JSON.parse(await readFile(trackedPath, "utf8").catch(() => "[]")) as string[];
  if (!tracked.includes(vaultPath)) {
    tracked.push(vaultPath);
    await writeFile(trackedPath, `${JSON.stringify(tracked, null, 2)}\n`, "utf8");
  }

  const args: Record<string, string> = { vaultPath };
  if (options.pluginSourceDir !== undefined) args.pluginDir = options.pluginSourceDir;
  const created = await client.call("obsidian_open", args);
  const sessionKey =
    created.json && typeof created.json === "object" && "session" in created.json
      ? created.json.session
      : undefined;
  if (typeof sessionKey !== "string") throw new Error(`obsidian_open failed: ${created.text}`);
  const session = JSON.parse(
    await readFile(join(home, "sessions", sessionKey, "session.json"), "utf8"),
  ) as LiveSessionDescriptor;
  const recordedVaultPath = resolve(session.ownership?.vaultPath ?? "");
  if (!session.ownership || recordedVaultPath !== vaultPath || session.vault?.grant !== "adopted") {
    throw new Error(`session ${sessionKey} did not bind the selected development vault`);
  }
  await stat(vaultPath);
  return { sessionKey, vaultPath, session };
}

export async function removeLiveHome(home: string): Promise<void> {
  const target = home ? resolve(home) : "";
  const tempRoot = resolve(tmpdir());
  if (!home || !target.startsWith(`${tempRoot}${sep}`)) {
    throw new Error(`refusing to remove non-temporary KNAP_HOME: ${home}`);
  }
  const env = { ...process.env, KNAP_HOME: home };
  const { quarantineSession, releaseSession, stopSession } =
    await import("../../dist/session/registry.js");
  const { readDescriptor } = await import("../../dist/session/descriptor.js");
  const keys = await readdir(join(home, "sessions")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const key of keys) {
    if ((await readDescriptor(key, env)) === undefined) continue;
    const stopped = await stopSession(key, { env });
    if (stopped.state === "quitFailed") {
      throw new Error(`refusing to remove ${home}: Obsidian for ${key} did not stop`);
    }
    const descriptor = await readDescriptor(key, env);
    if (descriptor?.vault?.grant === "adopted") await releaseSession(key, { env });
    else await quarantineSession(key, { env });
  }
  const tracked = JSON.parse(
    await readFile(join(home, LIVE_VAULTS_FILE), "utf8").catch(() => "[]"),
  ) as string[];
  for (const vaultPath of tracked) {
    const target = resolve(vaultPath);
    if (
      basename(dirname(target)) !== ".knapper" ||
      !basename(target).startsWith(`live-${basename(home)}-`)
    ) {
      throw new Error(`refusing to remove an unexpected live vault: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOTEMPTY") ||
        attempt === 9
      )
        throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

export async function findFreePort(): Promise<number | undefined> {
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
