import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("singleton session contract", () => {
  it("exposes session lifecycle tools instead of agent and workspace handles", async () => {
    const source = await readFile(join(root, "src", "server.ts"), "utf8");
    expect(source).toContain("obsidian_session_open");
    expect(source).toContain("never require a handle");

    const sessionToolPath = join(root, "src", "tools", "session.ts");
    const sessionTools = await readFile(sessionToolPath, "utf8");
    for (const name of [
      "obsidian_session_open",
      "obsidian_session_status",
      "obsidian_session_release",
      "obsidian_session_reset",
    ]) {
      expect(sessionTools).toContain(name);
    }
  });
});
