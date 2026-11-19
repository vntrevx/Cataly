import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ArtifactError, inspectArtifact, type ArtifactFile } from "./artifact-files.ts";
import {
  type Artifact,
  type ArtifactVersion,
  artifactHash,
  artifactText,
  parseArtifactManifest,
} from "./artifact-records.ts";
import { takeLock } from "./checkpoint-lock.ts";
import type { DoriConfig } from "./config.ts";
import { LANE_KEY, type Registry, statusOf } from "./registry.ts";

export type ArtifactView = Artifact & {
  readonly current: ArtifactFile | null;
  readonly state: "current" | "changed" | "unavailable";
  readonly problem: string | null;
};

export class Artifacts {
  constructor(
    readonly config: Pick<DoriConfig, "stateDir" | "artifactRoots">,
    readonly registry: Registry,
  ) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new ArtifactError("invalid artifact lane key");
    return join(this.config.stateDir, "lanes", key, "artifacts.json");
  }

  read(key: string): Artifact[] {
    let fd: number;
    try {
      fd = openSync(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ArtifactError("artifact index cannot be read; it was not replaced");
    }
    try {
      if (!fstatSync(fd).isFile()) throw new ArtifactError("artifact index is not a regular file");
      return parseArtifactManifest(readFileSync(fd, "utf8"), key);
    } finally {
      closeSync(fd);
    }
  }

  lock(key: string, now: number): () => void {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const release = takeLock(
      `${path}.lock`,
      now,
      () => new ArtifactError("artifact writer lock could not be restored"),
      { keepLiveOwner: true },
    );
    if (typeof release === "string") throw new ArtifactError("artifact index has an active writer");
    return release;
  }

  private write(key: string, entries: readonly Artifact[]): void {
    const path = this.path(key),
      temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, `${JSON.stringify({ schema: 1, key, artifacts: entries })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async add(
    key: string,
    path: string,
    title: string | undefined,
    visibility: "private" | "public",
    now: number,
  ): Promise<{ artifact: Artifact; unchanged: boolean }> {
    const name = title ?? basename(path);
    if (!artifactText(name, 200))
      throw new ArtifactError("artifact title must be 1-200 characters without control characters");
    const release = this.lock(key, now);
    try {
      const lane = await this.registry.read(key);
      if (!lane || statusOf(lane) === "closed")
        throw new ArtifactError("artifact registration requires an open registered lane");
      const entries = this.read(key);
      const file = await inspectArtifact(this.config.artifactRoots ?? [], path, visibility);
      const at = new Date(now).toISOString();
      const version: ArtifactVersion = {
        sha256: file.sha256,
        size: file.size,
        realPath: file.realPath,
        title: name,
        visibility,
        url: file.url,
        at,
      };
      const previous = entries.find((entry) => entry.path === file.path);
      const last = previous?.versions.at(-1);
      if (
        previous &&
        last &&
        last.sha256 === version.sha256 &&
        last.size === version.size &&
        last.realPath === version.realPath &&
        last.title === version.title &&
        last.visibility === version.visibility &&
        last.url === version.url
      )
        return { artifact: previous, unchanged: true };
      const artifact: Artifact = previous
        ? { ...previous, versions: [...previous.versions, version] }
        : { id: randomUUID(), path: file.path, createdAt: at, versions: [version], receipts: [] };
      this.write(
        key,
        previous ? entries.map((entry) => (entry.id === artifact.id ? artifact : entry)) : [...entries, artifact],
      );
      return { artifact, unchanged: false };
    } finally {
      release();
    }
  }

  delivered(
    key: string,
    id: string,
    sha256: string,
    reference: string,
    now: number,
  ): { artifact: Artifact; unchanged: boolean } {
    if (!artifactHash(sha256) || !artifactText(reference, 2000))
      throw new ArtifactError("delivery requires a SHA-256 and a nonempty receipt without control characters");
    const release = this.lock(key, now);
    try {
      const entries = this.read(key),
        previous = entries.find((entry) => entry.id === id);
      if (!previous?.versions.some((version) => version.sha256 === sha256))
        throw new ArtifactError("delivery hash must identify a registered artifact version");
      if (previous.receipts.some((receipt) => receipt.sha256 === sha256 && receipt.reference === reference))
        return { artifact: previous, unchanged: true };
      const artifact: Artifact = {
        ...previous,
        receipts: [
          ...previous.receipts,
          { sha256, reference, at: new Date(now).toISOString(), kind: "operator-reported" },
        ],
      };
      this.write(
        key,
        entries.map((entry) => (entry.id === id ? artifact : entry)),
      );
      return { artifact, unchanged: false };
    } finally {
      release();
    }
  }

  async views(key: string, entries = this.read(key)): Promise<ArtifactView[]> {
    const result: ArtifactView[] = [];
    for (const entry of entries) {
      const last = entry.versions.at(-1);
      if (!last) throw new ArtifactError("artifact has no registered version");
      try {
        const current = await inspectArtifact(this.config.artifactRoots ?? [], entry.path, last.visibility);
        const matches =
          current.sha256 === last.sha256 && current.realPath === last.realPath && current.url === last.url;
        result.push({ ...entry, current, state: matches ? "current" : "changed", problem: null });
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        result.push({ ...entry, current: null, state: "unavailable", problem: error.message });
      }
    }
    return result;
  }

  async evidence(key: string, ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    const entries = this.read(key),
      result: string[] = [];
    for (const id of new Set(ids)) {
      const entry = entries.find((value) => value.id === id);
      if (!entry) throw new ArtifactError("checkpoint artifact is not registered to this lane");
      const view = (await this.views(key, [entry]))[0];
      if (view?.state !== "current" || !view.current)
        throw new ArtifactError("checkpoint artifact changed or is unavailable; register its current version first");
      result.push(`artifact:${id}@sha256:${view.current.sha256}`);
    }
    return result;
  }
}
