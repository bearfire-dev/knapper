/**
 * Layer-0 spike: can two Obsidian instances run concurrently, each addressable on
 * both transports, without either one stealing the other's CLI socket?
 *
 * The whole multi-session design rests on two facts read out of
 * `/usr/lib/obsidian/obsidian.asar`, which this script exists to prove against a
 * live app rather than trust from a disassembly:
 *
 *   T = isWin ? `\\\\.\\pipe\\obsidian-cli-${os.userInfo().username}`
 *             : path.join((!isMac && process.env.XDG_RUNTIME_DIR) || os.homedir(),
 *                         ".obsidian-cli.sock")
 *   ...
 *   if (!app.requestSingleInstanceLock()) { /* become a CLI client, dial T *\/ }
 *   try { fs.unlinkSync(T) } catch {}
 *   cliServer.listen(T)
 *
 * So: `--user-data-dir` decides which Electron singleton lock you contend for
 * (⇒ whether a second instance can exist at all), and `XDG_RUNTIME_DIR` decides
 * which socket you bind or dial (⇒ which instance a CLI command reaches). The
 * `unlinkSync` before `listen` is why they can never be shipped apart: give two
 * instances separate profiles but one runtime dir and the last one to boot
 * silently steals the socket, so every CLI call lands in the wrong app with no
 * error at all.
 *
 * The trap that cost an afternoon: XDG_RUNTIME_DIR is not Obsidian's variable. It
 * is where a Wayland client resolves a relative WAYLAND_DISPLAY (`wayland-1`), and
 * where PipeWire and pulse look for their sockets. Point it at an empty per-session
 * directory and Electron never reaches the compositor: no window, no renderer, no
 * CDP port, no CLI socket — just a main process spinning at 25% CPU forever, with
 * nothing in any log to say why. The fix is to hand Wayland an ABSOLUTE socket path
 * (libwayland honours an absolute WAYLAND_DISPLAY and skips XDG_RUNTIME_DIR
 * entirely), which is what `sessionEnv` below does. DBUS_SESSION_BUS_ADDRESS is
 * already absolute on this system, so it needs no such treatment.
 *
 * Gates:
 *   1  both processes alive, each holding its own singleton lock
 *   2  each bound its own socket, and the user's real socket was NOT touched
 *   3  a CLI command follows XDG_RUNTIME_DIR — including the negative case,
 *      which is the half that actually proves routing
 *   4  two distinct CDP ports and two distinct browser uuids
 *   5  quitting one leaves the other fully alive on both transports
 *
 * This launches two real Obsidian windows on your desktop and closes them again.
 * It does not touch your own profile, vaults, or socket.
 *
 *   npx tsx scripts/spike-session-cli.ts
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface DevToolsInfo {
  port: number;
  browserId: string;
}

interface Session {
  id: string;
  root: string;
  userData: string;
  vault: string;
  vaultName: string;
  runtimeDir: string;
  pid?: number;
  cdp?: DevToolsInfo;
}

interface PathInfo {
  exists: boolean;
  isSocket?: boolean;
  ino?: number;
  mtimeMs?: number;
}

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
  error?: string;
}

interface CdpVersion {
  webSocketDebuggerUrl?: unknown;
}

declare global {
  interface Window {
    handleCli?: (args: string[]) => unknown;
  }
}

function errorDetails(error: unknown): { message?: string; stdout?: string } {
  if (error instanceof Error) return { message: error.message };
  if (typeof error !== "object" || error === null) return { message: String(error) };
  const details = error as { message?: unknown; stdout?: unknown };
  return {
    message: typeof details.message === "string" ? details.message : String(error),
    stdout: typeof details.stdout === "string" ? details.stdout : undefined,
  };
}

const BIN = process.env.OBSIDIAN_BIN ?? "obsidian";
const ROOT = process.env.SPIKE_ROOT ?? "/tmp/knap-spike";
const RUNTIME_BASE = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "knap-spike");
const LAUNCH_TIMEOUT_MS = 60_000;

/** The socket the user's own Obsidian owns. Gate 2 proves we never touch it. */
const REAL_SOCKET = process.env.XDG_RUNTIME_DIR
  ? join(process.env.XDG_RUNTIME_DIR, ".obsidian-cli.sock")
  : join(homedir(), ".obsidian-cli.sock");

const results: Record<string, unknown> = {};
let failures = 0;

/**
 * Environment for a process that must talk to ONE session's Obsidian.
 *
 * `XDG_RUNTIME_DIR` selects the CLI socket — that is the whole point. But it also
 * doubles as the Wayland/PipeWire socket directory, so overriding it blind severs
 * the compositor connection and the app hangs before it ever opens a window. Make
 * WAYLAND_DISPLAY absolute against the *real* runtime dir first; libwayland then
 * uses it verbatim and never consults XDG_RUNTIME_DIR.
 */
function sessionEnv(runtimeDir: string): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _stripped, ...rest } = process.env;
  const env: NodeJS.ProcessEnv = { ...rest, XDG_RUNTIME_DIR: runtimeDir };
  const wayland = process.env.WAYLAND_DISPLAY;
  if (wayland !== undefined && wayland !== "" && !wayland.startsWith("/")) {
    env.WAYLAND_DISPLAY = join(process.env.XDG_RUNTIME_DIR ?? "/run/user/1000", wayland);
  }
  return env;
}

function gate(name: string, ok: boolean, detail: Record<string, unknown>): void {
  results[name] = { ok, ...detail };
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function pathInfo(p: string): Promise<PathInfo> {
  try {
    const st = await stat(p);
    return { exists: true, isSocket: st.isSocket(), ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false };
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed a virgin Obsidian profile that boots straight into one vault with the CLI
 * already on.
 *
 * Order is load-bearing: the vault directory must exist before first launch. The
 * main process prunes the registry on boot with
 * `(!r.path || !fs.existsSync(r.path)) && delete P[e]`, so seeding an entry for a
 * directory that is not there yet silently deletes it and the app opens the vault
 * picker instead.
 */
async function seed(id: string, vaultName: string): Promise<Session> {
  const root = join(ROOT, id);
  const userData = join(root, "userdata");
  const vault = join(root, vaultName);
  const runtimeDir = join(RUNTIME_BASE, id);

  await mkdir(userData, { recursive: true });
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  // Matches what obsidian_create_vault writes today, but before first boot rather
  // than after a cold restart — nothing is running to overwrite it.
  await writeFile(
    join(vault, ".obsidian", "app.json"),
    JSON.stringify({ communityPluginEnabled: true }),
    "utf8",
  );

  // `cli: true` so the CLI transport is live on the very first boot, and
  // `open: true` so the app boots into this vault instead of the picker.
  await writeFile(
    join(userData, "obsidian.json"),
    JSON.stringify({
      vaults: { [randomBytes(8).toString("hex")]: { path: vault, ts: Date.now(), open: true } },
      cli: true,
    }),
    "utf8",
  );

  return { id, root, userData, vault, vaultName, runtimeDir };
}

/** Read `DevToolsActivePort`: line 1 is the port, line 2 the browser uuid path. */
async function readDevTools(userDataDir: string): Promise<DevToolsInfo | undefined> {
  try {
    const text = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
    const [portLine, idLine] = text.split("\n");
    const port = Number(portLine?.trim());
    return Number.isFinite(port) && port > 0
      ? { port, browserId: (idLine ?? "").trim() }
      : undefined;
  } catch {
    return undefined;
  }
}

async function probeCdp(port: number): Promise<CdpVersion | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as CdpVersion) : undefined;
  } catch {
    return undefined;
  }
}

async function launch(session: Session): Promise<Session> {
  const args = [
    `--user-data-dir=${session.userData}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--ozone-platform-hint=auto",
  ];
  const child = spawn(BIN, args, {
    detached: true,
    stdio: "ignore",
    env: sessionEnv(session.runtimeDir),
  });
  child.unref();
  session.pid = child.pid;

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const dt = await readDevTools(session.userData);
    if (dt && (await probeCdp(dt.port))) {
      session.cdp = dt;
      return session;
    }
    await sleep(500);
  }
  throw new Error(`${session.id}: CDP never came up within ${LAUNCH_TIMEOUT_MS}ms`);
}

/**
 * Run a CLI command as a *client* of a specific instance.
 *
 * Both flags matter and for different reasons. `--user-data-dir` makes this process
 * contend for that instance's singleton lock, which it loses — that is what turns it
 * into a forwarding client instead of a fresh cold boot. `XDG_RUNTIME_DIR` picks
 * which socket it forwards over. Obsidian's own argv prefilter drops every
 * `--`-prefixed token before `handleCli` sees it, so the flag never reaches the
 * command.
 */
async function cli(
  session: Session,
  runtimeDir: string,
  args: string[],
  timeout = 20_000,
): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync(BIN, [`--user-data-dir=${session.userData}`, ...args], {
      timeout,
      env: sessionEnv(runtimeDir),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error: unknown) {
    const details = errorDetails(error);
    return { ok: false, stdout: details.stdout?.trim() ?? "", error: details.message };
  }
}

async function quit(session: Session, timeoutMs = 20_000): Promise<void> {
  if (!session.pid) return;
  try {
    process.kill(session.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(session.pid)) return;
    await sleep(200);
  }
  try {
    process.kill(session.pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------

const realSocketBefore = await pathInfo(REAL_SOCKET);
console.log(`bin=${BIN}  root=${ROOT}  runtime=${RUNTIME_BASE}`);
console.log(`your socket before: ${JSON.stringify(realSocketBefore)}\n`);

await rm(ROOT, { recursive: true, force: true });
await rm(RUNTIME_BASE, { recursive: true, force: true });

const a = await seed("a", "spike-a");
const b = await seed("b", "spike-b");

let launched: Session[] = [];
try {
  // Sequential, not parallel: the socket steal we are testing for is a race on
  // boot order, and launching together would make gate 2 flaky rather than wrong.
  await launch(a);
  launched.push(a);
  await launch(b);
  launched.push(b);
  if (!a.cdp || !b.cdp) throw new Error("CDP details missing after launch");
  console.log(`launched a: pid=${a.pid} port=${a.cdp.port}`);
  console.log(`launched b: pid=${b.pid} port=${b.cdp.port}\n`);

  await sleep(10_000);

  // ---- Gate 1: two live instances -----------------------------------------
  gate("1-both-alive", alive(a.pid) && alive(b.pid), { aPid: a.pid, bPid: b.pid });

  // ---- Gate 2: separate sockets, user's socket untouched -------------------
  const aSock = await pathInfo(join(a.runtimeDir, ".obsidian-cli.sock"));
  const bSock = await pathInfo(join(b.runtimeDir, ".obsidian-cli.sock"));
  const realSocketAfter = await pathInfo(REAL_SOCKET);
  gate("2a-own-sockets", aSock.isSocket === true && bSock.isSocket === true, { aSock, bSock });
  gate(
    "2b-real-socket-untouched",
    realSocketBefore.exists === realSocketAfter.exists &&
      realSocketBefore.ino === realSocketAfter.ino,
    { before: realSocketBefore, after: realSocketAfter },
  );

  // ---- Gate 3: CLI follows XDG_RUNTIME_DIR ---------------------------------
  const aToA = await cli(a, a.runtimeDir, ["vault=spike-a", "eval", "code=app.vault.getName()"]);
  const bToB = await cli(b, b.runtimeDir, ["vault=spike-b", "eval", "code=app.vault.getName()"]);
  gate("3a-a-reaches-a", aToA.stdout.includes("spike-a"), { stdout: aToA.stdout.slice(0, 200) });
  gate("3b-b-reaches-b", bToB.stdout.includes("spike-b"), { stdout: bToB.stdout.slice(0, 200) });

  // The negative. Ask for spike-a's vault over spike-b's socket: instance B has
  // never heard of that vault, so a correctly-routed call must be refused. If this
  // *succeeds*, routing is not per-session and the whole design collapses back to
  // a shared CLI with handleCli as the primary transport.
  const aToB = await cli(b, b.runtimeDir, ["vault=spike-a", "eval", "code=app.vault.getName()"]);
  gate("3c-cross-instance-refused", !aToB.stdout.includes("spike-a"), {
    stdout: aToB.stdout.slice(0, 200),
  });

  // ---- Gate 4: distinct CDP identities -------------------------------------
  const aVer = await probeCdp(a.cdp.port);
  const bVer = await probeCdp(b.cdp.port);
  gate(
    "4-distinct-cdp",
    a.cdp.port !== b.cdp.port &&
      a.cdp.browserId !== b.cdp.browserId &&
      aVer !== undefined &&
      bVer !== undefined &&
      (typeof aVer?.webSocketDebuggerUrl === "string" ? aVer.webSocketDebuggerUrl : "").includes(
        a.cdp.browserId.replace(/^\/?devtools\//, ""),
      ),
    {
      aPort: a.cdp.port,
      bPort: b.cdp.port,
      aId: a.cdp.browserId,
      bId: b.cdp.browserId,
      aWs: aVer?.webSocketDebuggerUrl,
    },
  );

  // ---- S2: handleCli is reachable over CDP --------------------------------
  // The documented fallback when per-session sockets are unavailable (macOS,
  // Windows). Cheap to check while two instances are up.
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${a.cdp.port}`, {
      noDefaults: true,
      isLocal: true,
    });
    const page = browser
      .contexts()[0]
      ?.pages()
      .find((p) => p.url().startsWith("app://obsidian.md/"));
    const typeofHandleCli = page ? await page.evaluate(() => typeof window.handleCli) : "no-page";
    const viaCdp =
      page && typeof (await page.evaluate(() => typeof window.handleCli)) === "function"
        ? await page.evaluate(() => Promise.resolve(window.handleCli?.(["files", "format=json"])))
        : undefined;
    await browser.close();
    gate("S2-handleCli-over-cdp", typeofHandleCli === "function", {
      typeofHandleCli,
      sample: typeof viaCdp === "string" ? viaCdp.slice(0, 120) : viaCdp,
    });
  } catch (e) {
    gate("S2-handleCli-over-cdp", false, { error: String(e).slice(0, 200) });
  }

  // ---- Gate 5: quitting one leaves the other alone -------------------------
  await quit(a);
  launched = launched.filter((s) => s !== a);
  await sleep(2000);
  const bStillCdp = await probeCdp(b.cdp.port);
  const bStillCli = await cli(b, b.runtimeDir, [
    "vault=spike-b",
    "eval",
    "code=app.vault.getName()",
  ]);
  gate(
    "5-quit-is-scoped",
    !alive(a.pid) &&
      alive(b.pid) &&
      bStillCdp !== undefined &&
      bStillCli.stdout.includes("spike-b"),
    { aAlive: alive(a.pid), bAlive: alive(b.pid), bCdp: bStillCdp !== undefined },
  );
} finally {
  for (const s of launched) await quit(s);
  await rm(ROOT, { recursive: true, force: true });
  await rm(RUNTIME_BASE, { recursive: true, force: true });
}

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(results, null, 2));
console.log(failures === 0 ? "\nALL GATES PASSED" : `\n${failures} GATE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
