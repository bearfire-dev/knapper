/**
 * Keep every published manifest's version in step with package.json.
 *
 * The same version string is declared in four places across four files, because
 * each plugin host (Cursor / Claude Code / Codex) insists on its own manifest
 * dialect. A release that bumps package.json alone ships plugin manifests that
 * claim the previous version, which is invisible locally and only shows up as a
 * wrong version in someone's client.
 *
 *   npm run versions:sync   # rewrite manifests from package.json
 *   npm run versions:check  # fail if any manifest has drifted (CI)
 *
 * All progress output goes to stderr. This script runs from the `prepare`
 * lifecycle hook, which npm executes during `npm pack` — and `npm pack --json`
 * writes the tarball manifest to stdout, so a single console.log here produces
 * invalid JSON and breaks the release workflow's tarball-name lookup.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

/**
 * Every version field we own, as a path into the parsed JSON. Add to this list
 * rather than hand-editing a manifest, or the next release drifts again.
 */
const TARGETS = [
  { file: ".cursor-plugin/plugin.json", paths: [["version"]] },
  { file: ".claude-plugin/plugin.json", paths: [["version"]] },
  { file: ".codex-plugin/plugin.json", paths: [["version"]] },
] as const;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getIn(obj: unknown, path: readonly string[]): JsonValue | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current as JsonValue | undefined;
}

const pkg: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = isJsonObject(pkg) ? pkg.version : undefined;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  exitWithError(`package.json has a malformed version: ${JSON.stringify(version)}`);
}
const expectedVersion = version;

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}

let drifted = 0;
let rewrote = 0;

for (const { file, paths } of TARGETS) {
  const abs = join(root, file);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    console.error(`missing manifest: ${file}`);
    drifted++;
    continue;
  }

  const json: unknown = JSON.parse(raw);
  let next = raw;
  let changed = false;

  for (const path of paths) {
    const current = getIn(json, path);
    if (current === expectedVersion) continue;
    const where = `${file}#${path.join(".")}`;
    if (check) {
      console.error(`  drift: ${where} is ${JSON.stringify(current)}, expected ${expectedVersion}`);
      drifted++;
    } else {
      next = replaceVersionString(next, current, expectedVersion, where);
      console.error(`  set ${where} -> ${expectedVersion}`);
      changed = true;
    }
  }

  if (changed) {
    await writeFile(abs, next);
    rewrote++;
  }
}

/**
 * Rewrite one version string in place, leaving every other byte alone.
 *
 * Deliberately not `JSON.stringify(parsed, null, 2)`. Re-serializing reformats
 * fields this script has no opinion about — it collapsed or expanded arrays
 * such as `keywords` — so `npm run versions:sync` produced manifests that `npm run
 * check` then rejected. Since AGENTS.md tells contributors to run the sync
 * rather than hand-edit, that made every release fail CI on formatting, in a
 * file the author never touched.
 *
 * Anchored on the old value rather than a bare `"version"` key so a nested
 * occurrence cannot be hit by accident, and asserts exactly one match so a
 * silent partial rewrite is impossible.
 */
function replaceVersionString(
  text: string,
  current: JsonValue | undefined,
  next: string,
  where: string,
): string {
  const needle = typeof current === "string" ? JSON.stringify(current) : undefined;
  if (needle === undefined) {
    console.error(`  cannot rewrite ${where}: current value is not a version string`);
    process.exit(1);
  }
  const occurrences = text.split(needle).length - 1;
  if (occurrences !== 1) {
    console.error(
      `  cannot rewrite ${where}: found ${occurrences} occurrences of ${needle}, expected exactly 1`,
    );
    process.exit(1);
  }
  return text.replace(needle, JSON.stringify(next));
}

if (check) {
  if (drifted > 0) {
    console.error(
      `\n${drifted} manifest version(s) out of sync with package.json (${expectedVersion}).\n` +
        "Run: npm run versions:sync",
    );
    process.exit(1);
  }
  console.error(`all manifests agree on version ${expectedVersion}`);
} else {
  console.error(
    rewrote === 0 ? `already in sync at ${expectedVersion}` : `synced ${rewrote} manifest(s)`,
  );
}
