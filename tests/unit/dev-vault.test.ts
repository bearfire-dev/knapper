import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareDevelopmentPaths } from "../../src/session/dev-vault.js";

const execFileAsync = promisify(execFile);

async function repository(ignore = ".obsidian-test/\n") {
  const root = await mkdtemp(join(tmpdir(), "knapper-dev-vault-"));
  await execFileAsync("git", ["init", "--quiet", root]);
  await writeFile(join(root, ".gitignore"), ignore, "utf8");
  const pluginDir = join(root, "plugin");
  await mkdir(pluginDir);
  return { root, pluginDir };
}

describe("prepareDevelopmentPaths", () => {
  it("creates an ignored vault below the plugin repository", async () => {
    const { root, pluginDir } = await repository();
    const vaultPath = join(root, ".obsidian-test");

    await expect(prepareDevelopmentPaths(vaultPath, pluginDir)).resolves.toEqual({
      vaultPath,
      pluginDir,
      repositoryRoot: root,
    });
  });

  it("refuses a path that Git does not ignore", async () => {
    const { root, pluginDir } = await repository();

    await expect(
      prepareDevelopmentPaths(join(root, "visible-vault"), pluginDir),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("refuses paths outside the plugin repository", async () => {
    const { pluginDir } = await repository();
    const outside = await mkdtemp(join(tmpdir(), "knapper-outside-vault-"));

    await expect(prepareDevelopmentPaths(outside, pluginDir)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("refuses a symlink in the vault path", async () => {
    const { root, pluginDir } = await repository("ignored-link/\n");
    const destination = await mkdtemp(join(tmpdir(), "knapper-linked-vault-"));
    await symlink(destination, join(root, "ignored-link"));

    await expect(
      prepareDevelopmentPaths(join(root, "ignored-link"), pluginDir),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
