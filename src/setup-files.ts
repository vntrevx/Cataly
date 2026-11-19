import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileDigest, owned, realDirectory, regularFile } from "./release/files.ts";
import { saveDeploymentText } from "./update/deployment-files.ts";
import { digest } from "./update/source.ts";

export type SetupSnapshot = {
  readonly path: string;
  readonly stamp: string | null;
  readonly sha256: string | null;
  readonly mode: number;
  readonly gid: number | null;
};

/** No file content or credentials enter the setup snapshot. */
export function captureSetupFile(input: string): SetupSnapshot {
  const path = resolve(input);
  realDirectory(dirname(path));
  owned(dirname(path));
  if (!regularFile(path)) return { path, stamp: null, sha256: null, mode: 0o600, gid: null };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    const stamp = (stat: typeof before) =>
      [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    if (!before.isFile() || (process.getuid !== undefined && before.uid !== BigInt(process.getuid())))
      throw new Error(`Owned regular configuration required: ${path}`);
    if ((before.mode & 0o022n) !== 0n)
      throw new Error(
        `Group/world-writable configuration: ${path}; remove write permissions with chmod go-w, then rerun --preview`,
      );
    const sha256 = fileDigest(fd);
    if (
      stamp(before) !== stamp(fstatSync(fd, { bigint: true })) ||
      stamp(before) !== stamp(lstatSync(path, { bigint: true }))
    )
      throw new Error(`Configuration changed while being read: ${path}; rerun setup after the edit finishes`);
    return {
      path,
      stamp: stamp(before),
      sha256,
      mode: Number(before.mode & 0o7777n),
      gid: Number(before.gid),
    };
  } finally {
    closeSync(fd);
  }
}

export function assertSetupFile(snapshot: SetupSnapshot): void {
  const current = captureSetupFile(snapshot.path);
  if (
    current.stamp !== snapshot.stamp ||
    current.sha256 !== snapshot.sha256 ||
    current.mode !== snapshot.mode ||
    current.gid !== snapshot.gid
  )
    throw new Error(
      `Configuration changed during setup: ${snapshot.path}; keep the edit and rerun --preview before installing`,
    );
}

export function setupPreview(snapshot: SetupSnapshot, text: string | Buffer, managedKeys: readonly string[]) {
  const afterSha256 = digest(text);
  return {
    path: snapshot.path,
    action: snapshot.stamp === null ? "create" : afterSha256 === snapshot.sha256 ? "preserve" : "update",
    beforeSha256: snapshot.sha256,
    afterSha256,
    managedKeys,
    unknownKeys: "preserved",
  };
}

/** Existing files use optimistic CAS immediately before rename; absent files use atomic no-clobber creation. */
export function publishSetupFile(snapshot: SetupSnapshot, text: string | Buffer): SetupSnapshot {
  assertSetupFile(snapshot);
  const expected = digest(text);
  if (expected === snapshot.sha256) return snapshot;
  realDirectory(dirname(snapshot.path), true);
  owned(dirname(snapshot.path));
  saveDeploymentText(snapshot.path, text, {
    mode: snapshot.mode,
    ...(snapshot.gid === null ? {} : { gid: snapshot.gid }),
    createOnly: snapshot.stamp === null,
    beforePublish: () => assertSetupFile(snapshot),
  });
  const observed = captureSetupFile(snapshot.path);
  if (
    observed.sha256 !== expected ||
    observed.mode !== snapshot.mode ||
    (snapshot.gid !== null && observed.gid !== snapshot.gid)
  )
    throw new Error(
      `Configuration readback differs after publication: ${snapshot.path}; inspect the current file before retrying`,
    );
  return observed;
}
