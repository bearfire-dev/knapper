import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createLogger } from "../../src/util/logger.js";
import type { ToolAuditEvent } from "../../src/audit/types.js";

type ToolCallback = (
  args: Record<string, unknown>,
  context?: { requestId?: string | number },
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function fakeServer(callbacks: Map<string, ToolCallback>): McpServer {
  return {
    registerTool: vi.fn((name: string, _config: unknown, callback: ToolCallback) => {
      callbacks.set(name, callback);
      return {} as never;
    }),
  } as unknown as McpServer;
}

describe("ToolRegistry runtime toolsets", () => {
  it("serializes every handler through one FIFO lane", async () => {
    const handles = new Map<string, ToolCallback>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: false,
      beforeInvoke: async () => void 0,
    });
    registry.add({
      name: "workspace_read",
      toolset: "core",
      description: "Read one workspace through the shared runtime.",
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        order.push(`start:${String(args.name)}`);
        if (args.name === "first") await firstBlocked;
        order.push(`end:${String(args.name)}`);
        return "ok";
      },
    });
    registry.bind(fakeServer(handles));

    const first = handles.get("workspace_read")?.({ name: "first" });
    await vi.waitFor(() => expect(order).toContain("start:first"));
    const second = handles.get("workspace_read")?.({ name: "second" });

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("keeps finalization inside the FIFO lane", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const order: string[] = [];
    let releaseAfter!: () => void;
    const afterBlocked = new Promise<void>((resolve) => {
      releaseAfter = resolve;
    });
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: false,
      beforeInvoke: async (_definition, args) => void order.push(`before:${String(args.name)}`),
      afterInvoke: async (_definition, args) => {
        order.push(`after:${String(args.name)}`);
        if (args.name === "first") await afterBlocked;
      },
    });
    registry.add({
      name: "finalized_call",
      toolset: "core",
      description: "Verify that finalization completes before the next queued call starts.",
      handler: async (args) => {
        order.push(`handler:${String(args.name)}`);
        return "ok";
      },
    });
    registry.bind(fakeServer(callbacks));

    const first = callbacks.get("finalized_call")?.({ name: "first" });
    await vi.waitFor(() => expect(order).toContain("after:first"));
    const second = callbacks.get("finalized_call")?.({ name: "second" });
    await Promise.resolve();
    expect(order).not.toContain("before:second");

    releaseAfter();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "before:first",
      "handler:first",
      "after:first",
      "before:second",
      "handler:second",
      "after:second",
    ]);
  });

  it("does not register disabled startup-only toolsets", () => {
    const callbacks = new Map<string, ToolCallback>();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"));
    registry.add({
      name: "browser_example",
      toolset: "ui",
      description: "Browser example.",
      handler: async () => "ok",
    });
    registry.bind(fakeServer(callbacks));

    expect(callbacks.has("browser_example")).toBe(false);
    expect(registry.toolsetState().disabled).toContain("ui");

    expect(callbacks.has("browser_example")).toBe(false);
    expect(registry.byToolset().ui).toBeUndefined();
  });

  it("keeps control-plane tools enabled with their toolset disabled", () => {
    const callbacks = new Map<string, ToolCallback>();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"));
    registry.add({
      name: "obsidian_toolsets",
      toolset: "core",
      alwaysEnabled: true,
      description: "Manage toolsets.",
      handler: async () => "ok",
    });
    registry.bind(fakeServer(callbacks));

    expect(callbacks.has("obsidian_toolsets")).toBe(true);
    expect(registry.names()).toContain("obsidian_toolsets");
  });

  it("returns native structured content without duplicate fenced JSON", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: false,
    });
    registry.add({
      name: "structured_example",
      toolset: "core",
      description: "Structured example.",
      handler: async () => ({ text: "Found 2 items.", json: { count: 2, items: ["a", "b"] } }),
    });
    registry.bind(fakeServer(callbacks));

    const result = await callbacks.get("structured_example")?.({}, { requestId: 7 });

    expect(result?.content).toEqual([{ type: "text", text: "Found 2 items." }]);
    expect(result?.structuredContent).toEqual({ count: 2, items: ["a", "b"] });
    expect(JSON.stringify(result?.content)).not.toContain("```json");
  });

  it("keeps plain text for clients that do not read structured content", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: false,
    });
    registry.add({
      name: "json_only_example",
      toolset: "core",
      description: "JSON-only example.",
      handler: async () => ({ json: [1, 2] }),
    });
    registry.bind(fakeServer(callbacks));

    const result = await callbacks.get("json_only_example")?.({});

    expect(result?.content[0]?.text).toContain("1");
    expect(result?.content[0]?.text).not.toContain("```");
    expect(result?.structuredContent).toEqual({ result: [1, 2] });
  });

  it("runs request hooks and emits one redacted audit event", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const events: ToolAuditEvent[] = [];
    const order: string[] = [];
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: { write: async (event) => void events.push(event) },
      beforeInvoke: async () => void order.push("before"),
      contextProvider: async () => ({
        clientInfo: { name: "codex", version: "1.2.3" },
        transport: "stdio",
        protocolVersion: "2025-11-25",
        traceId: "trace-1",
        workspaceKind: "vault",
      }),
    });
    registry.add({
      name: "audited_example",
      toolset: "core",
      description: "Audited example.",
      handler: async () => {
        order.push("handler");
        return "ok";
      },
    });
    registry.bind(fakeServer(callbacks));

    await callbacks.get("audited_example")?.(
      { code: "private code", text: "private note", settings: { token: "private" } },
      { requestId: "request-1" },
    );

    expect(order).toEqual(["before", "handler"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "audited_example",
      outcome: "success",
      arguments: {
        count: 3,
        keys: ["code", "settings", "text"],
        types: { code: "string", settings: "object", text: "string" },
        redacted: true,
      },
    });
    expect(events[0]?.request_id).toMatch(/^sha256:/);
    expect(events[0]?.trace_id).toMatch(/^sha256:/);
    expect(events[0]?.client?.name).toMatch(/^sha256:/);
    expect(events[0]?.client?.version).toMatch(/^sha256:/);
    expect(JSON.stringify(events[0])).not.toContain("private");
  });

  it("runs cleanup after a precondition hook fails", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const afterInvoke = vi.fn();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: false,
      beforeInvoke: async () => {
        throw new Error("missing target");
      },
      afterInvoke,
    });
    registry.add({
      name: "precondition_failure",
      toolset: "core",
      description: "Fail after admission to verify that activity cleanup still runs.",
      handler: async () => "unreachable",
    });
    registry.bind(fakeServer(callbacks));

    const result = await callbacks.get("precondition_failure")?.({});

    expect(result?.isError).toBe(true);
    expect(afterInvoke).toHaveBeenCalledOnce();
    expect(afterInvoke.mock.calls[0]?.[3]).toMatchObject({ code: "INTERNAL" });
  });

  it("does not block tools or build an audit queue behind a stalled write", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const write = vi.fn(() => new Promise<void>(() => undefined));
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: { write },
    });
    registry.add({
      name: "stalled_audit_example",
      toolset: "core",
      description: "Stalled audit example.",
      handler: async () => "ok",
    });
    registry.bind(fakeServer(callbacks));

    await callbacks.get("stalled_audit_example")?.({});
    await callbacks.get("stalled_audit_example")?.({});

    expect(write).toHaveBeenCalledTimes(1);
  });

  it("emits a redacted error envelope and native error details", async () => {
    const callbacks = new Map<string, ToolCallback>();
    const events: ToolAuditEvent[] = [];
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), undefined, {
      audit: { write: async (event) => void events.push(event) },
    });
    registry.add({
      name: "failed_example",
      toolset: "core",
      description: "Failed example.",
      handler: async () => {
        throw new Error("private typed text");
      },
    });
    registry.bind(fakeServer(callbacks));

    const result = await callbacks.get("failed_example")?.({}, { requestId: "request-2" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ code: "INTERNAL" });
    expect(result?.content).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toEqual({
      type: "UobError",
      code: "INTERNAL",
      message: "The tool call failed.",
      retriable: false,
    });
    expect(JSON.stringify(events[0])).not.toContain("private typed text");
  });
});
