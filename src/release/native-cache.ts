import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { owned, readJson, realDirectory } from "./files.ts";
import type { NativeReceipt } from "./native.ts";
import { protections } from "./native-cache-refs.ts";
import { processCwds } from "./process-cwd.ts";
import { readSourceBundle } from "./source-bundle.ts";

/**
 * One native cache identity as the report sees it. Nothing here removes a directory: references, launches and other
 * Dori processes share no lock with this scan, so an identity it finds unused may be in use a moment later.
 */
export type NativeCacheEntry = {
  readonly directory: string;
  readonly identity: string;
  /** Bytes whose every hard link lies inside this directory: what removing it would free. */
  readonly bytes: number;
  /** What the scan found using this identity, or could not rule out; empty means none was found. */
  readonly protectedBy: readonly string[];
};

const ENTRY = new RegExp(`^native-${process.platform}-${process.arch}-([a-f0-9]{64})$`);

/** Freed bytes: inodes whose link count is fully accounted for inside the directory (shared Bun cache links are not). */
function exclusiveBytes(directory: string): number {
  const inodes = new Map<string, { size: number; links: number; seen: number }>();
  const stack = [directory];
  let bytes = 0;
  while (stack.length) {
    const path = stack.pop()!;
    const stat = lstatSync(path);
    // Directory nlink includes . and child .. entries, not external hardlinks to retain.
    if (stat.isDirectory()) {
      bytes += stat.size;
      for (const name of readdirSync(path)) stack.push(join(path, name));
      continue;
    }
    const key = `${stat.dev}:${stat.ino}`;
    const inode = inodes.get(key) ?? { size: stat.size, links: stat.nlink, seen: 0 };
    inode.seen++;
    inodes.set(key, inode);
  }
  for (const inode of inodes.values()) if (inode.seen >= inode.links) bytes += inode.size;
  return bytes;
}

/** An entry's receipt counts while it is unrecognized, or while the source that prepared it binds it or cannot be read. */
function receiptHolds(directory: string, identity: string): string[] {
  try {
    realDirectory(directory);
    owned(directory);
    const receipt = readJson(join(directory, "receipt.json"));
    if (!recognized(receipt, identity, directory)) return ["unrecognized receipt"];
    try {
      return readSourceBundle(receipt.source, true).identity === identity ? ["receipt source"] : [];
    } catch {
      // A source that is gone binds nothing; one whose lock is there but cannot be read could still bind it.
      return lstatSync(join(receipt.source, "native-omp.lock"), { throwIfNoEntry: false })
        ? ["unreadable receipt source lock"]
        : [];
    }
  } catch {
    return ["unrecognized receipt"];
  }
}

/** Report every native cache identity of this platform with what uses it (see `protections`). It removes nothing. */
export function reportNativeCache(
  home: string,
  sources: readonly string[],
  roots: readonly string[],
  readCwds: typeof processCwds = processCwds,
): NativeCacheEntry[] {
  const cache = join(home, ".cache/omp-dori");
  if (!lstatSync(cache, { throwIfNoEntry: false })) return [];
  realDirectory(cache);
  owned(cache);
  const found = readdirSync(cache)
    .map((name) => ({ name, match: ENTRY.exec(name) }))
    .filter((entry) => entry.match)
    .map(({ name, match }) => ({ directory: join(cache, name), identity: match![1]! }));
  const reasons = protections(
    cache,
    found.map((entry) => entry.identity),
    sources,
    roots,
    readCwds,
  );
  return found.map(({ directory, identity }) => ({
    directory,
    identity,
    bytes: exclusiveBytes(directory),
    protectedBy: [...(reasons.get(identity) ?? []), ...receiptHolds(directory, identity)],
  }));
}

// The receipt contract `prepareNative` writes (src/release/native.ts NativeReceipt): any other shape is kept unread.
const RECEIPT_TEXT = [
  "source",
  "directory",
  "omp",
  "ompHash",
  "entry",
  "bun",
  "bunHash",
  "addonLockHash",
  "addon",
  "addonHash",
];
function recognized(receipt: unknown, identity: string, directory: string): receipt is NativeReceipt {
  if (typeof receipt !== "object" || receipt === null) return false;
  const fields = receipt as Record<string, unknown>;
  return (
    fields["version"] === 1 &&
    fields["identity"] === identity &&
    fields["directory"] === directory &&
    RECEIPT_TEXT.every((name) => typeof fields[name] === "string" && fields[name] !== "")
  );
}
