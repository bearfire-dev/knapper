import { mkdtemp, mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VaultFence } from "../../src/connection/fence.js";
import { sessionPaths } from "../../src/config.js";
import { SESSION_SCHEMA_VERSION, writeDescriptor } from "../../src/session/descriptor.js";
import { sessionBootId } from "../../src/session/ownership.js";
import { createLogger } from "../../src/util/logger.js";

describe("VaultFence adopted session binding", () => {
  it("authorizes the exact recorded external vault and refuses its replacement", async () => {
    const home = await mkdtemp(join(tmpdir(), "knapper-adopted-session-"));
    const env = { ...process.env, KNAP_HOME: home };
    const key = "adopted-a3f19c22";
    const paths = sessionPaths(key, env);
    const vaultPath = join(home, "repository", ".obsidian-test");
    await mkdir(paths.userDataDir, { recursive: true });
    await mkdir(vaultPath, { recursive: true });
    const [rootIdentity, vaultIdentity] = await Promise.all([stat(paths.root), stat(vaultPath)]);
    const bootId = await sessionBootId();
    await writeDescriptor(
      {
        schema: SESSION_SCHEMA_VERSION,
        key,
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        readiness: { phase: "ready", readyAt: new Date().toISOString() },
        origin: { cwd: home },
        ownership: {
          rootPath: await realpath(paths.root),
          vaultPath: await realpath(vaultPath),
          rootDevice: rootIdentity.dev,
          rootInode: rootIdentity.ino,
          vaultDevice: vaultIdentity.dev,
          vaultInode: vaultIdentity.ino,
          ...(bootId !== undefined ? { bootId } : {}),
        },
        instance: {
          userDataDir: paths.userDataDir,
          outputDir: paths.outputDir,
          obsidianBin: "obsidian",
        },
        vault: {
          id: "external-id",
          name: ".obsidian-test",
          path: vaultPath,
          grant: "adopted",
        },
      },
      env,
    );
    const configPath = join(paths.userDataDir, "obsidian.json");
    await writeFile(
      configPath,
      JSON.stringify({ vaults: { "external-id": { path: vaultPath, open: true } } }),
    );
    const fence = new VaultFence({
      configPath,
      env,
      logger: createLogger("silent"),
      sessionKey: key,
      sessionVaultPath: vaultPath,
    });

    expect((await fence.resolve()).grant).toBe("adopted");
    await rename(vaultPath, `${vaultPath}-old`);
    await mkdir(vaultPath);
    fence.invalidate();
    await expect(fence.resolve()).rejects.toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
  });
});
