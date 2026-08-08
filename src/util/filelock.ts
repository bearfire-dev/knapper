/**
 * Advisory locking across knapper processes.
 *
 * `CallLock` guards one process's tool dispatch; this guards the few resources
 * several knapper processes genuinely share — the session registry, and ownership
 * of an individual session.
 *
 * Built on `open(path, "wx")` (O_CREAT|O_EXCL) rather than `flock`, for two
 * reasons: node exposes no `flock` without a native addon, and `flock` is a no-op
 * on some network filesystems, which would make the lock silently stop working
 * rather than fail. Exclusive create is atomic on every local filesystem.
 *
 * The cost of that choice is that a crashed holder leaves the file behind, so a
 * lock records who took it and when, and a later contender may break one whose
 * owner is provably gone. Staleness is decided by process liveness first and a
 * timeout only as a backstop — a wall-clock rule alone would either break a
 * healthy long operation or leave a dead one's lock forever.
 */

import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { UobError } from "./errors.js";

export interface FileLockOptions {
  /** How long to wait for a contended lock before giving up. */
  timeoutMs?: number;
  /** How old an unverifiable lock may get before its file is broken. */
  staleMs?: number;
  /** Poll interval while waiting. */
  retryMs?: number;
}

interface LockRecord {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Backstop for incomplete records whose process owner cannot be verified. */
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_RETRY_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Should an existing lock file be broken?
 *
 * Only when its local owner is gone, or an unverifiable record is old enough to
 * prove that its writer did not finish. A live local PID and another host are
 * never overridden by wall-clock age.
 */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  const oldByMtime = async (): Promise<boolean> => {
    try {
      return Date.now() - (await stat(path)).mtimeMs > staleMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  };

  let record: Partial<LockRecord>;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return oldByMtime();
    record = parsed as Partial<LockRecord>;
  } catch {
    // A contender can observe the file between exclusive creation and the record
    // write. Only an old incomplete file is evidence of a crashed holder.
    return oldByMtime();
  }

  if (typeof record.hostname === "string" && record.hostname !== hostname()) return false;
  if (typeof record.pid === "number") return !isAlive(record.pid);

  const acquiredAt = Date.parse(record.acquiredAt ?? "");
  return Number.isFinite(acquiredAt) ? Date.now() - acquiredAt > staleMs : oldByMtime();
}

/**
 * Run `fn` holding an exclusive lock on `lockPath`.
 *
 * Always released, including when `fn` throws — a leaked lock is worse than the
 * race it was taken to prevent, because the next contender waits the full timeout
 * before it can even diagnose the problem.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;

  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx");
      const record: LockRecord = {
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      if (await isStale(lockPath, staleMs)) {
        // Break it and retry rather than take it directly: two processes may reach
        // this line together, and the exclusive create on the next pass is what
        // decides between them.
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }

      if (Date.now() >= deadline) {
        let holder = "unknown";
        try {
          const record = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
          holder = `pid ${record.pid} on ${record.hostname} since ${record.acquiredAt}`;
        } catch {
          /* leave unknown */
        }
        throw new UobError("TIMEOUT", `Timed out waiting for the lock at ${lockPath}.`, {
          remediation:
            "Another knapper process is holding it. Wait for it to finish, or remove the lock file " +
            "if you are certain that process is gone.",
          details: { lockPath, holder, timeoutMs },
        });
      }

      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}
