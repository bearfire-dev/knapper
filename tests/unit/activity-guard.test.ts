import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_RECORD_NAME, ActivityGuard } from "../../src/usage/activity-guard.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knap-activity-"));
  env = { KNAP_HOME: root };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ActivityGuard", () => {
  it("rejects an idle window shorter than the heartbeat floor", () => {
    expect(() => new ActivityGuard({ idleTimeoutMs: 999, env })).toThrow(
      "activity idle timeout must be at least 1000 ms",
    );
  });

  it("starts free, tracks an operation, and does not renew from status", async () => {
    let now = new Date("2026-08-08T12:00:00Z");
    const first = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      now: () => now,
      pid: process.pid,
    });
    expect((await first.status()).state).toBe("free");
    await first.acquire({ operation: "browser_click", sessionOpen: true });
    expect((await first.status()).state).toBe("self");
    await first.complete(true);
    now = new Date("2026-08-08T12:00:10Z");
    await first.status();
    now = new Date("2026-08-08T12:00:31Z");
    expect((await first.status()).state).toBe("stale");
  });

  it("reports a live session as busy to another process and includes retry time", async () => {
    const first = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      pid: process.pid,
      hostname: "host-a",
    });
    await first.acquire({ sessionOpen: true });
    const second = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      pid: process.pid,
      hostname: "host-b",
    });
    const status = await second.status();
    expect(status).toMatchObject({
      state: "busy",
      sessionOpen: true,
      retryAfterMs: expect.any(Number),
    });
    await expect(second.acquire()).rejects.toMatchObject({ code: "KNAPPER_BUSY" });
  });

  it("completes operations, keeps session state, and releases its own record", async () => {
    const guard = new ActivityGuard({ idleTimeoutMs: 30_000, env, pid: process.pid });
    await guard.acquire({ sessionOpen: true });
    await guard.complete(false);
    expect(await guard.status()).toMatchObject({
      state: "self",
      activeOperations: 0,
      sessionOpen: false,
    });
    expect((await guard.status()).owner).not.toHaveProperty("currentOperation");
    await guard.release();
    expect((await guard.status()).state).toBe("free");
    expect(await readFile(join(root, ACTIVITY_RECORD_NAME)).catch(() => undefined)).toBeUndefined();
  });

  it("reclaims an expired owner", async () => {
    let now = new Date("2026-08-08T12:00:00Z");
    const first = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      now: () => now,
      pid: process.pid,
      hostname: "host-a",
    });
    await first.acquire({ sessionOpen: true });
    await first.complete(true);
    now = new Date("2026-08-08T12:00:31Z");
    const second = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      now: () => now,
      pid: process.pid,
      hostname: "host-b",
    });
    await expect(second.acquire({ sessionOpen: false })).resolves.toBeDefined();
    expect((await second.status()).state).toBe("self");
  });

  it("renews ownership while an operation is active", async () => {
    let now = new Date("2026-08-08T12:00:00Z");
    const guard = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      now: () => now,
      pid: process.pid,
    });
    await guard.acquire({ operation: "long-running-test", sessionOpen: true });

    now = new Date("2026-08-08T12:00:25Z");
    await guard.heartbeat();
    now = new Date("2026-08-08T12:00:31Z");
    expect((await guard.status()).state).toBe("self");

    await guard.complete(false);
    await guard.release();
  });

  it("does not reclaim an expired record while its local operation is active", async () => {
    let now = new Date("2026-08-08T12:00:00Z");
    const first = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      now: () => now,
      pid: process.pid,
    });
    await first.acquire({ operation: "long-running-test", sessionOpen: true });

    now = new Date("2026-08-08T12:00:31Z");
    const second = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      now: () => now,
      pid: process.pid,
    });
    await expect(second.acquire()).rejects.toMatchObject({ code: "KNAPPER_BUSY" });

    await first.complete(false);
    await first.release();
  });

  it("refuses to release ownership while the managed session is open", async () => {
    const guard = new ActivityGuard({ idleTimeoutMs: 30_000, env, pid: process.pid });
    await guard.acquire({ sessionOpen: true });
    await guard.complete();

    await expect(guard.release()).rejects.toMatchObject({ code: "KNAPPER_BUSY" });

    await guard.acquire({ sessionOpen: false });
    await guard.complete(false);
    await guard.release();
  });

  it("reports a completion failure and repairs its operation count on the next call", async () => {
    const errors: unknown[] = [];
    const guard = new ActivityGuard({
      idleTimeoutMs: 30_000,
      env,
      pid: process.pid,
      onError: (error) => errors.push(error),
    });
    await guard.acquire({ sessionOpen: true });
    await chmod(root, 0o500);
    try {
      await expect(guard.complete(true)).rejects.toBeDefined();
      expect(errors).toHaveLength(1);
    } finally {
      await chmod(root, 0o700);
    }
    await guard.acquire({ sessionOpen: false });
    await guard.complete(false);
    expect(await guard.status()).toMatchObject({ activeOperations: 0, sessionOpen: false });
    await guard.release();
  });
});
