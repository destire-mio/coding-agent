import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BigIntStats } from "node:fs";

const FILE_VERSION_PREFIX = "file-version-v1:";
const FILE_VERSION_SECRET_BYTES = 32;

export interface FileVersion {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNs: string;
  readonly changedNs: string;
}

export function createFileVersionSecret(): Buffer {
  return randomBytes(FILE_VERSION_SECRET_BYTES);
}

export function toFileVersion(fileStat: BigIntStats): FileVersion {
  return {
    device: fileStat.dev.toString(),
    inode: fileStat.ino.toString(),
    size: fileStat.size.toString(),
    modifiedNs: fileStat.mtimeNs.toString(),
    changedNs: fileStat.ctimeNs.toString(),
  };
}

export function sameFileVersion(
  left: FileVersion,
  right: FileVersion,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

export function issueFileVersionToken(
  path: string,
  version: FileVersion,
  secret: Uint8Array,
): string {
  const signature = createHmac("sha256", secret)
    .update(fileVersionIdentity(path, version))
    .digest("base64url");
  return `${FILE_VERSION_PREFIX}${signature}`;
}

export function matchesFileVersionToken(
  token: string,
  path: string,
  version: FileVersion,
  secret: Uint8Array,
): boolean {
  const expected = issueFileVersionToken(path, version, secret);
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function fileVersionIdentity(path: string, version: FileVersion): string {
  return [
    path,
    version.device,
    version.inode,
    version.size,
    version.modifiedNs,
    version.changedNs,
  ].join("\0");
}
