/** Validate the caller-selected vault before Knapper creates or opens it. */

import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { UobError } from "../util/errors.js";

const execFileAsync = promisify(execFile);

function invalid(message: string, details: Record<string, unknown>): UobError {
  return new UobError("INVALID_ARGUMENT", message, {
    remediation:
      "Use an absolute vault path inside the plugin Git repository and add that path to .gitignore.",
    details,
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (error) {
    throw invalid("Knapper could not find the Git repository for this development session.", {
      cwd,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function rejectSymlinkComponents(root: string, target: string): Promise<void> {
  const suffix = relative(root, target);
  let current = root;
  for (const component of suffix === "" ? [] : suffix.split(sep)) {
    current = join(current, component);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry === undefined) return;
    if (entry.isSymbolicLink()) {
      throw invalid("The development vault path cannot contain symbolic links.", {
        vaultPath: target,
        symlink: current,
      });
    }
  }
}

export interface DevelopmentPaths {
  vaultPath: string;
  pluginDir?: string;
  repositoryRoot: string;
}

/**
 * Bind one development vault to the Git repository that owns the plugin.
 *
 * The ignored-path requirement makes the safe convention executable instead of
 * leaving it as prompt advice. Knapper may create the final directory, but it
 * never creates an ignore rule or accepts a path outside the repository.
 */
export async function prepareDevelopmentPaths(
  vaultPathInput: string,
  pluginDirInput?: string,
): Promise<DevelopmentPaths> {
  if (!isAbsolute(vaultPathInput)) {
    throw invalid("vaultPath must be an absolute path.", { vaultPath: vaultPathInput });
  }
  if (pluginDirInput !== undefined && !isAbsolute(pluginDirInput)) {
    throw invalid("pluginDir must be an absolute path.", { pluginDir: pluginDirInput });
  }

  const base = resolve(pluginDirInput ?? process.cwd());
  const baseEntry = await lstat(base).catch(() => undefined);
  if (baseEntry?.isDirectory() !== true || baseEntry.isSymbolicLink()) {
    throw invalid("pluginDir must be a real directory.", { pluginDir: base });
  }
  const canonicalBase = await realpath(base);
  if (canonicalBase !== base) {
    throw invalid("pluginDir cannot contain symbolic links.", { pluginDir: base });
  }

  const repositoryRoot = resolve(await gitOutput(canonicalBase, ["rev-parse", "--show-toplevel"]));
  if ((await realpath(repositoryRoot)) !== repositoryRoot) {
    throw invalid("The Git repository path cannot contain symbolic links.", {
      repositoryRoot,
    });
  }

  const vaultPath = resolve(vaultPathInput);
  const vaultRelative = relative(repositoryRoot, vaultPath);
  if (
    vaultRelative === "" ||
    vaultRelative === ".." ||
    vaultRelative.startsWith(`..${sep}`) ||
    isAbsolute(vaultRelative)
  ) {
    throw invalid("vaultPath must be below the plugin Git repository root.", {
      vaultPath,
      repositoryRoot,
    });
  }

  await rejectSymlinkComponents(repositoryRoot, vaultPath);
  try {
    await execFileAsync(
      "git",
      ["check-ignore", "--quiet", "--no-index", "--", `${vaultPath}${sep}`],
      { cwd: repositoryRoot },
    );
  } catch {
    throw invalid("Git does not ignore the selected development vault.", {
      vaultPath,
      repositoryRoot,
    });
  }

  const existing = await lstat(vaultPath).catch(() => undefined);
  if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw invalid("vaultPath must identify a real directory.", { vaultPath });
  }
  await mkdir(vaultPath, { recursive: true, mode: 0o700 });
  const canonicalVault = await realpath(vaultPath);
  if (canonicalVault !== vaultPath) {
    throw invalid("The development vault path cannot contain symbolic links.", {
      vaultPath,
    });
  }

  return {
    vaultPath: canonicalVault,
    ...(pluginDirInput !== undefined ? { pluginDir: canonicalBase } : {}),
    repositoryRoot,
  };
}
