/** Verify and renew the filesystem identity of one managed scratch session. */

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultObsidianUserDataDir, sessionPaths } from "../config.js";
import { patchDescriptor, type SessionDescriptor, type SessionOwnership } from "./descriptor.js";

async function currentBootId(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function currentBootStartedAt(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const text = await readFile("/proc/stat", "utf8");
    const match = /^btime (\d+)$/m.exec(text);
    return match?.[1] === undefined ? undefined : Number(match[1]) * 1000;
  } catch {
    return undefined;
  }
}

function sameRecordedIdentity(
  left: SessionOwnership | undefined,
  right: SessionOwnership,
): boolean {
  return (
    left?.rootPath === right.rootPath &&
    left.vaultPath === right.vaultPath &&
    left.rootDevice === right.rootDevice &&
    left.rootInode === right.rootInode &&
    left.vaultDevice === right.vaultDevice &&
    left.vaultInode === right.vaultInode &&
    left.bootId === right.bootId
  );
}

async function renewRecordedOwnership(
  descriptor: SessionDescriptor,
  ownership: SessionOwnership,
  rootDevice: number,
  vaultDevice: number,
  bootId: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const renewed = await patchDescriptor(
    descriptor.key,
    (current) => {
      if (!sameRecordedIdentity(current.ownership, ownership)) return current;
      return {
        ...current,
        ownership: { ...ownership, rootDevice, vaultDevice, bootId },
      };
    },
    env,
  );
  return (
    renewed?.ownership?.rootDevice === rootDevice &&
    renewed.ownership.vaultDevice === vaultDevice &&
    renewed.ownership.bootId === bootId
  );
}

/** Return true only when the descriptor still owns its exact recorded binding. */
export async function verifySessionOwnership(
  descriptor: SessionDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  bootReader: {
    id(): Promise<string | undefined>;
    startedAt(): Promise<number | undefined>;
  } = { id: currentBootId, startedAt: currentBootStartedAt },
): Promise<boolean> {
  const paths = sessionPaths(descriptor.key, env);
  const ownership = descriptor.ownership;
  const recordedVaultPath = descriptor.vault?.path;
  if (
    ownership === undefined ||
    descriptor.vault === undefined ||
    recordedVaultPath === undefined ||
    (descriptor.vault.grant === "created" &&
      resolve(recordedVaultPath) !== resolve(paths.vaultDir)) ||
    resolve(descriptor.instance.userDataDir) !== resolve(paths.userDataDir) ||
    resolve(descriptor.instance.userDataDir) === resolve(defaultObsidianUserDataDir())
  ) {
    return false;
  }

  let observed;
  try {
    observed = await Promise.all([
      lstat(paths.root),
      lstat(recordedVaultPath),
      realpath(paths.root),
      realpath(recordedVaultPath),
      stat(paths.root),
      stat(recordedVaultPath),
    ]);
  } catch {
    return false;
  }
  const [rootLink, vaultLink, rootPath, vaultPath, rootIdentity, vaultIdentity] = observed;

  if (
    !rootLink.isDirectory() ||
    !vaultLink.isDirectory() ||
    rootLink.isSymbolicLink() ||
    vaultLink.isSymbolicLink() ||
    rootPath !== ownership.rootPath ||
    vaultPath !== ownership.vaultPath ||
    rootIdentity.ino !== ownership.rootInode ||
    vaultIdentity.ino !== ownership.vaultInode
  ) {
    return false;
  }

  const devicesMatch =
    rootIdentity.dev === ownership.rootDevice && vaultIdentity.dev === ownership.vaultDevice;
  const bootId = await bootReader.id();
  if (bootId === undefined) return devicesMatch && ownership.bootId === undefined;
  if (devicesMatch && ownership.bootId === bootId) return true;

  if (devicesMatch) {
    return renewRecordedOwnership(
      descriptor,
      ownership,
      rootIdentity.dev,
      vaultIdentity.dev,
      bootId,
      env,
    );
  }

  const crossedBoot =
    ownership.bootId !== undefined
      ? ownership.bootId !== bootId
      : ((await bootReader.startedAt()) ?? 0) > Date.parse(descriptor.createdAt);
  if (!crossedBoot) return false;

  return renewRecordedOwnership(
    descriptor,
    ownership,
    rootIdentity.dev,
    vaultIdentity.dev,
    bootId,
    env,
  );
}

/** Record the boot that supplied a new session's device numbers. */
export async function sessionBootId(): Promise<string | undefined> {
  return currentBootId();
}
