import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { WorkspaceTelemetryStore } from "../../src/telemetry/workspace-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function telemetryPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "knap-telemetry-"));
  roots.push(root);
  return join(root, "events.jsonl");
}

describe("TelemetryStore JSONL persistence", () => {
  it("keeps default-profile and managed-session histories isolated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knap-workspace-telemetry-"));
    roots.push(dir);
    const store = new WorkspaceTelemetryStore(20, dir);

    store.select("default");
    store.add({ source: "console", level: "warn", text: "default" });
    store.select("session");
    expect(store.query().records).toEqual([]);
    store.add({ source: "console", level: "error", text: "session" });
    store.select("default");
    expect(store.query().records.map((record) => record.text)).toEqual(["default"]);
    store.closePersistence();

    const restarted = new WorkspaceTelemetryStore(20, dir);
    restarted.select("default");
    expect(restarted.query().records.map((record) => record.text)).toEqual(["default"]);
    restarted.select("session");
    expect(restarted.query().records.map((record) => record.text)).toEqual(["session"]);
  });

  it("archives a closed session history beside its retained files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knap-workspace-telemetry-"));
    const retainedRoot = await mkdtemp(join(tmpdir(), "knap-retained-workspace-"));
    roots.push(dir, retainedRoot);
    const store = new WorkspaceTelemetryStore(20, dir);

    store.select("session");
    store.add({ source: "console", level: "warn", text: "archive me" });
    store.select("default");
    const archivedPath = await store.archive("session", retainedRoot);

    expect(archivedPath).toBe(join(retainedRoot, "telemetry", "events.jsonl"));
    expect(await readFile(archivedPath!, "utf8")).toContain("archive me");
    await expect(readFile(join(dir, "session.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to archive telemetry for the active session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knap-workspace-telemetry-"));
    const retainedRoot = await mkdtemp(join(tmpdir(), "knap-retained-workspace-"));
    roots.push(dir, retainedRoot);
    const store = new WorkspaceTelemetryStore(20, dir);

    store.select("session");
    await expect(store.archive("session", retainedRoot)).rejects.toThrow(
      "Cannot archive telemetry while the managed session is active.",
    );
  });

  it("reloads records and continues the monotonic cursor", async () => {
    const path = await telemetryPath();
    const first = new TelemetryStore(10, { jsonlPath: path });
    first.add({ source: "console", level: "info", text: "one" });
    first.add({ source: "pageerror", level: "error", text: "two" });
    first.closePersistence();

    const second = new TelemetryStore(10, { jsonlPath: path });
    const added = second.add({ source: "marker", level: "info", text: "three" });

    expect(second.query().records.map((record) => record.text)).toEqual(["one", "two", "three"]);
    expect(added.seq).toBe(3);
    expect(second.persistenceSummary()).toEqual({
      enabled: true,
      loaded: 2,
      loadErrors: 0,
      writeErrors: 0,
    });
  });

  it("preserves the cursor when clear removes durable records", async () => {
    const path = await telemetryPath();
    const first = new TelemetryStore(10, { jsonlPath: path });
    first.add({ source: "console", level: "log", text: "remove me" });
    first.clear();

    expect(first.cursor).toBe(1);
    expect(first.query().records).toEqual([]);

    const second = new TelemetryStore(10, { jsonlPath: path });
    expect(second.cursor).toBe(1);
    expect(second.query().records).toEqual([]);
    expect(second.add({ source: "marker", level: "info", text: "next" }).seq).toBe(2);
    expect(await readFile(path, "utf8")).not.toContain("remove me");
  });

  it("compacts durable history instead of growing without a record bound", async () => {
    const path = await telemetryPath();
    const capacity = 10;
    const store = new TelemetryStore(capacity, { jsonlPath: path });
    for (let index = 0; index < 250; index++) {
      store.add({ source: "console", level: "info", text: `record-${index}` });
    }
    store.closePersistence();

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(capacity + 99);
    const restarted = new TelemetryStore(capacity, { jsonlPath: path });
    expect(restarted.cursor).toBe(250);
    expect(restarted.query().records.at(-1)?.text).toBe("record-249");
  });

  it("skips malformed lines and reports explicit empty counts", async () => {
    const path = await telemetryPath();
    await writeFile(path, "not-json\n", "utf8");

    const store = new TelemetryStore(10, { jsonlPath: path });

    expect(store.persistenceSummary().loadErrors).toBe(1);
    expect(store.recordCounts()).toEqual({
      total: 0,
      byLevel: { debug: 0, info: 0, log: 0, warn: 0, error: 0 },
      bySource: { console: 0, pageerror: 0, exception: 0, network: 0, marker: 0 },
    });
  });
});
