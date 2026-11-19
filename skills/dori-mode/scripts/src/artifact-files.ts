import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactRoot } from "./artifact-config.ts";

export class ArtifactError extends Error {}
export type ArtifactFile = {
  readonly path: string;
  readonly realPath: string;
  readonly sha256: string;
  readonly size: number;
  readonly url: string | null;
};

export const artifactWithin = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const extensions = new Set(
  "html css js json png jpg jpeg gif webp avif svg ico woff woff2 ttf otf md txt csv pdf wav mp3 ogg m4a flac mp4 webm mov".split(
    " ",
  ),
);
const allowed = (root: string, path: string): void => {
  if (!artifactWithin(root, path)) throw new ArtifactError("artifact is outside its configured root");
  const parts = relative(root, path).split(sep);
  if (
    parts.some(
      (part) =>
        part.startsWith(".") ||
        /secret|credential|token|private|[\p{Cc}\p{Cf}]/iu.test(part) ||
        ["node_modules", "__pycache__", "site-packages"].includes(part.toLowerCase()),
    )
  )
    throw new ArtifactError("artifact has a hidden, sensitive or dependency path");
  if (!extensions.has(extname(path).slice(1).toLowerCase()))
    throw new ArtifactError("artifact file type is not allowed");
};
const same = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** A snapshot of actual bytes, not mtime-based identity or a promise that a URL was fetched. */
export const inspectArtifact = async (
  roots: readonly ArtifactRoot[],
  input: string,
  visibility: "private" | "public",
): Promise<ArtifactFile> => {
  let fd: number | undefined;
  try {
    const path = resolve(input);
    const root = roots
      .filter((entry) => artifactWithin(entry.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) throw new ArtifactError("artifact requires an explicitly configured containing root");
    if (visibility === "public" && !root.baseUrl)
      throw new ArtifactError("public artifact requires an explicit baseUrl on its root");
    allowed(root.path, path);
    const realRoot = realpathSync(root.path);
    if (!statSync(realRoot).isDirectory()) throw new ArtifactError("artifact root must be a directory");
    const realPath = realpathSync(path);
    allowed(realRoot, realPath);
    const before = statSync(realPath, { bigint: true });
    if (!before.isFile()) throw new ArtifactError("artifact must be a regular file");
    fd = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(before, fstatSync(fd, { bigint: true }))) throw new ArtifactError("artifact changed while opening");
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw new ArtifactError("artifact size is not safely representable");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(realPath, { fd, autoClose: false, end: Math.max(0, size - 1) }))
      hash.update(chunk);
    const after = fstatSync(fd, { bigint: true });
    if (
      !same(before, after) ||
      realpathSync(root.path) !== realRoot ||
      realpathSync(path) !== realPath ||
      !same(after, statSync(path, { bigint: true }))
    )
      throw new ArtifactError("artifact changed while hashing; register the stable file again");
    const encoded = relative(root.path, path)
      .split(sep)
      .map((part) =>
        encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
      )
      .join("/");
    return {
      path,
      realPath,
      sha256: hash.digest("hex"),
      size,
      url: visibility === "public" ? `${root.baseUrl}${encoded}` : null,
    };
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("artifact cannot be read or changed during inspection");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};
