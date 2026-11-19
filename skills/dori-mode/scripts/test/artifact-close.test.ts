import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactClose, artifactNote } from "../src/artifact-report.ts";
import { Artifacts } from "../src/artifacts.ts";
import { closeLane } from "../src/done-flow.ts";
import { Registry, statusOf } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { ARTIFACT_NOW as now, artifactFixture } from "./artifact-fixture.ts";
import { fakeClock } from "./fakes.ts";

let f: Awaited<ReturnType<typeof artifactFixture>>;
beforeEach(async () => {
  f = await artifactFixture();
});
afterEach(() => f.state.done());
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({
    code: 0,
    error: result.stderr.toString(),
  });
};
const worktree = async () => {
  const repo = join(f.state.dir, "repo"),
    tree = join(f.state.dir, "worktree");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "done.txt"), "done");
  writeFileSync(join(repo, "report.txt"), "delivered evidence");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
  git(repo, "worktree", "add", "-q", "-b", f.lane.key, tree);
  const notification = join(f.state.dir, "notification.txt");
  const config = {
    ...f.config,
    defaultCwd: repo,
    artifactRoots: [{ path: tree, baseUrl: "https://files.example/tree/" }],
    hooks: {
      threadDone: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        notification,
        "{text}",
      ],
    },
  };
  const lane = { ...f.lane, thread: "fixture", cwd: repo, worktrees: [tree] };
  await f.registry.write(lane);
  const artifacts = new Artifacts(config, f.registry);
  const deps = { config, registry: f.registry, clock: fakeClock(now), run };
  return { repo, tree, notification, lane, artifacts, deps };
};

test("real git cleanup preserves a clean committed artifact and final hook receives the current URL/hash", async () => {
  const w = await worktree();
  const entry = (await w.artifacts.add(w.lane.key, join(w.tree, "report.txt"), "Evidence", "public", now)).artifact;
  const result = await closeLane(w.deps, w.lane, "Complete");
  expect(result.closed).toBe(true);
  expect(existsSync(join(w.tree, "report.txt"))).toBe(true);
  const after = await f.registry.read(w.lane.key);
  expect(after && statusOf(after)).toBe("closed");
  const text = readFileSync(w.notification, "utf8");
  expect(text).toContain("https://files.example/tree/report.txt");
  expect(text).toContain(`sha256=${entry.versions[0]?.sha256}`);
  expect(text).not.toContain(w.tree);
  expect(after).toHaveProperty("receipt.note", text);
  expect(w.artifacts.read(w.lane.key)[0]?.receipts).toEqual([]);
  expect(result.lines.join("\n")).toContain("kept: registered artifacts");
});
test("a clean worktree without registered artifacts is still removed by real git", async () => {
  const w = await worktree();
  expect((await closeLane(w.deps, w.lane, "Complete")).closed).toBe(true);
  expect(existsSync(w.tree)).toBe(false);
  expect(readFileSync(w.notification, "utf8")).toBe("Complete");
});
test("private files keep their worktree without leaking a name, title or path to the hook", async () => {
  const w = await worktree();
  await w.artifacts.add(w.lane.key, join(w.tree, "report.txt"), "Internal title", "private", now);
  expect((await closeLane(w.deps, w.lane, "Complete")).closed).toBe(true);
  expect(existsSync(w.tree)).toBe(true);
  const text = readFileSync(w.notification, "utf8");
  expect(text).toContain("Private artifacts omitted: 1");
  expect(text).not.toContain("Internal title");
  expect(text).not.toContain(w.tree);
  expect(text).not.toContain("https://");
});
test.each(["corrupt", "writer", "dangling-index"])(
  "close conservatively keeps files when index state is %s",
  async (kind) => {
    const w = await worktree();
    const release = w.artifacts.lock(w.lane.key, now);
    try {
      if (kind !== "writer") {
        release();
        if (kind === "corrupt") writeFileSync(w.artifacts.path(w.lane.key), "{");
        else symlinkSync(join(f.state.dir, "missing-index"), w.artifacts.path(w.lane.key));
      }
      expect((await closeLane(w.deps, w.lane, "Complete")).closed).toBe(true);
      expect(existsSync(w.tree)).toBe(true);
      expect(readFileSync(w.notification, "utf8")).toContain("Artifacts unavailable or writer active");
    } finally {
      if (kind === "writer") release();
    }
  },
);
test("an alias outside a worktree still preserves its canonical target inside it", async () => {
  const w = await worktree();
  const config = { ...w.deps.config, artifactRoots: [{ path: f.state.dir, baseUrl: "https://files.example/all/" }] };
  const artifacts = new Artifacts(config, f.registry);
  const alias = join(f.root, "alias.txt");
  symlinkSync(join(w.tree, "report.txt"), alias);
  await artifacts.add(w.lane.key, alias, "Evidence", "public", now);
  expect((await closeLane({ ...w.deps, config }, w.lane, "Complete")).closed).toBe(true);
  expect(existsSync(join(w.tree, "report.txt"))).toBe(true);
  expect(readFileSync(alias, "utf8")).toBe("delivered evidence");
});

test("close during an admitted real registration preserves its files and reports the active writer", async () => {
  const w = await worktree();
  const observed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  // Delay only delivery of a real disk read to force the interleaving; no state or command result is fabricated.
  const registry = new (class extends Registry {
    override async read(key: string) {
      const entry = await super.read(key);
      observed.resolve();
      await resume.promise;
      return entry;
    }
  })(f.config.stateDir);
  const artifacts = new Artifacts(w.deps.config, registry);
  const registering = artifacts.add(w.lane.key, join(w.tree, "report.txt"), "Evidence", "public", now);
  await observed.promise;
  let closed: Awaited<ReturnType<typeof closeLane>>;
  try {
    closed = await closeLane(w.deps, w.lane, "Complete");
  } finally {
    resume.resolve();
    await registering;
  }
  expect(closed.closed).toBe(true);
  expect(existsSync(join(w.tree, "report.txt"))).toBe(true);
  expect(w.artifacts.read(w.lane.key)).toHaveLength(1);
  expect(readFileSync(w.notification, "utf8")).toContain("Artifacts unavailable or writer active");
  await expect(w.artifacts.add(w.lane.key, join(w.tree, "report.txt"), "Evidence", "public", now)).rejects.toThrow(
    "open registered lane",
  );
});

test("changed or deleted files never become a new successful public delivery", async () => {
  await f.artifacts.add(f.lane.key, f.path, undefined, "public", now);
  writeFileSync(f.path, "changed");
  expect(await artifactNote(f.artifacts, f.lane.key)).toContain("changed; public link withheld");
  const closed = await artifactClose(f.artifacts, f.lane.key, now);
  expect(closed.note).not.toContain("https://files.example/");
  expect(closed.entries).toHaveLength(1);
  unlinkSync(f.path);
  expect(await artifactNote(f.artifacts, f.lane.key)).toContain("unavailable; public link withheld");
  expect(f.artifacts.read(f.lane.key)[0]?.receipts).toEqual([]);
});
