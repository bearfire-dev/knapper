import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { knapperHome } from "../config.js";
import { readPidStartTime } from "../connection/health.js";
import { writeJsonAtomic } from "../util/atomic-json.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";

export interface ActivityRecord {
  schema: 1;
  token: string;
  pid: number;
  pidStartTime?: number;
  hostname: string;
  acquiredAt: string;
  lastActivityAt: string;
  activeOperations: number;
  currentOperation?: string;
  sessionOpen: boolean;
}

export type ActivityState = "free" | "self" | "busy" | "stale";

export interface ActivityOwner extends Omit<ActivityRecord, "token"> {}

export interface ActivityStatus {
  state: ActivityState;
  owner?: ActivityOwner;
  lastActivityAt?: string;
  sessionOpen?: boolean;
  activeOperations?: number;
  retryAfterMs?: number;
}

export interface ActivityGuardOptions {
  idleTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pid?: number;
  hostname?: string;
  onError?: (error: unknown) => void;
}

export interface AcquireOptions {
  operation?: string;
  sessionOpen?: boolean;
}

export const ACTIVITY_RECORD_NAME = "usage.json";
const lockName = "usage.lock";

/** A single, cross-process activity lane for the managed Obsidian instance. */
export class ActivityGuard {
  private readonly token = randomUUID();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly host: string;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private readonly opts: ActivityGuardOptions) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.pid = opts.pid ?? process.pid;
    this.host = opts.hostname ?? hostname();
    if (!Number.isFinite(opts.idleTimeoutMs) || opts.idleTimeoutMs < 1_000) {
      throw new UobError(
        "INVALID_ARGUMENT",
        "The activity idle timeout must be at least 1000 ms.",
        {
          remediation: "Set KNAP_ACTIVITY_IDLE_MS to at least 1000 milliseconds.",
        },
      );
    }
  }

  private path(): string {
    return join(knapperHome(this.env), ACTIVITY_RECORD_NAME);
  }

  private async read(): Promise<ActivityRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(), "utf8")) as ActivityRecord;
      return value.schema === 1 && typeof value.token === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(value: ActivityRecord): Promise<void> {
    await writeJsonAtomic(this.path(), value, { mode: 0o600, directoryMode: 0o700 });
  }

  private async ownerAlive(value: ActivityRecord): Promise<boolean> {
    if (value.hostname !== this.host) return true;
    try {
      process.kill(value.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    if (value.pidStartTime === undefined || process.platform !== "linux") return true;
    return (await readPidStartTime(value.pid)) === value.pidStartTime;
  }

  private expired(value: ActivityRecord, now = this.now()): boolean {
    const time = Date.parse(value.lastActivityAt);
    return !Number.isFinite(time) || now.getTime() - time >= this.opts.idleTimeoutMs;
  }

  private withoutToken(value: ActivityRecord): ActivityOwner {
    const { token: _token, ...owner } = value;
    return owner;
  }

  private retryAfter(value: ActivityRecord): number {
    const time = Date.parse(value.lastActivityAt);
    return Number.isFinite(time)
      ? Math.max(0, time + this.opts.idleTimeoutMs - this.now().getTime())
      : 0;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    const intervalMs = Math.max(250, Math.floor(this.opts.idleTimeoutMs / 3));
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((error) => this.reportError(error));
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private reportError(error: unknown): void {
    this.stopHeartbeat();
    this.opts.onError?.(error);
  }

  async heartbeat(): Promise<void> {
    await withFileLock(join(knapperHome(this.env), lockName), async () => {
      const existing = await this.read();
      if (existing?.token !== this.token || existing.activeOperations === 0) {
        this.stopHeartbeat();
        return;
      }
      await this.write({ ...existing, lastActivityAt: this.now().toISOString() });
    });
  }

  async status(): Promise<ActivityStatus> {
    const value = await this.read();
    if (value === undefined) return { state: "free" };
    const owner = this.withoutToken(value);
    const dead = !(await this.ownerAlive(value));
    const old = value.activeOperations === 0 && this.expired(value);
    if (dead || old) {
      return {
        state: "stale",
        owner,
        lastActivityAt: value.lastActivityAt,
        sessionOpen: value.sessionOpen,
        activeOperations: value.activeOperations,
        retryAfterMs: 0,
      };
    }
    if (value.token === this.token) {
      return {
        state: "self",
        owner,
        lastActivityAt: value.lastActivityAt,
        sessionOpen: value.sessionOpen,
        activeOperations: value.activeOperations,
      };
    }
    const busy = value.activeOperations > 0 || value.sessionOpen;
    return {
      state: busy ? "busy" : "free",
      owner: busy ? owner : undefined,
      lastActivityAt: value.lastActivityAt,
      sessionOpen: value.sessionOpen,
      activeOperations: value.activeOperations,
      ...(busy ? { retryAfterMs: this.retryAfter(value) } : {}),
    };
  }

  async acquire(options: AcquireOptions = {}): Promise<ActivityRecord> {
    return withFileLock(join(knapperHome(this.env), lockName), async () => {
      const now = this.now();
      const existing = await this.read();
      const own = existing?.token === this.token;
      const reclaimable =
        existing === undefined ||
        (existing !== undefined &&
          (!(await this.ownerAlive(existing)) ||
            (existing.activeOperations === 0 && this.expired(existing))));
      if (
        !own &&
        !reclaimable &&
        existing !== undefined &&
        (existing.activeOperations > 0 || existing.sessionOpen)
      ) {
        throw new UobError(
          "KNAPPER_BUSY",
          "Another Knapper agent is using the managed Obsidian instance.",
          {
            remediation: "Wait for the other agent to finish, then retry.",
            details: {
              owner: this.withoutToken(existing),
              retryAfterMs: this.retryAfter(existing),
            },
          },
        );
      }
      const record: ActivityRecord = {
        schema: 1,
        token: this.token,
        pid: this.pid,
        ...(process.platform === "linux" ? { pidStartTime: await readPidStartTime(this.pid) } : {}),
        hostname: this.host,
        acquiredAt: own && existing ? existing.acquiredAt : now.toISOString(),
        lastActivityAt: now.toISOString(),
        // Tool dispatch is a single FIFO lane. Resetting this value also repairs
        // a record left active by a failed completion write.
        activeOperations: 1,
        ...(options.operation ? { currentOperation: options.operation } : {}),
        sessionOpen: options.sessionOpen ?? (own && existing ? existing.sessionOpen : false),
      };
      await this.write(record);
      this.startHeartbeat();
      return record;
    });
  }

  async complete(sessionOpen?: boolean): Promise<void> {
    try {
      await withFileLock(join(knapperHome(this.env), lockName), async () => {
        const existing = await this.read();
        if (existing?.token !== this.token) {
          this.stopHeartbeat();
          return;
        }
        const { currentOperation: _currentOperation, ...record } = existing;
        await this.write({
          ...record,
          lastActivityAt: this.now().toISOString(),
          activeOperations: 0,
          ...(sessionOpen === undefined ? {} : { sessionOpen }),
        });
        this.stopHeartbeat();
      });
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  async release(): Promise<void> {
    await withFileLock(join(knapperHome(this.env), lockName), async () => {
      const existing = await this.read();
      if (existing?.token !== this.token) {
        this.stopHeartbeat();
        return;
      }
      if (existing.activeOperations > 0 || existing.sessionOpen) {
        throw new UobError("KNAPPER_BUSY", "The managed session is still active.", {
          remediation:
            "Close the managed session and complete all active operations before releasing the guard.",
        });
      }
      this.stopHeartbeat();
      await rm(this.path(), { force: true });
    });
  }
}
