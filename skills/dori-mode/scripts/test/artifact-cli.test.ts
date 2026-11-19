import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { withStatus } from "../src/registry.ts";
import { artifactFixture } from "./artifact-fixture.ts";

let f: Awaited<ReturnType<typeof artifactFixture>>;
const cli = resolve(import.meta.dir, "../src/cli.ts");
beforeEach(async () => {
  f = await artifactFixture();
  writeFileSync(join(f.state.dir, "config.json"), JSON.stringify(f.config));
});
afterEach(() => f.state.done());
const invoke = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: f.root,
    env: {
      HOME: f.state.dir,
      TMPDIR: tmpdir(),
      PATH: process.env["PATH"],
      DORI_CONFIG: join(f.state.dir, "config.json"),
      DORI_RUNTIME: "herdr",
      DO_NOT_TRACK: "1",
      DORI_TELEMETRY: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

test("actual CLI adds, lists, binds checkpoints, reports and records content-bound delivery", () => {
  const added = invoke("artifact", "add", f.lane.key, f.path, "--title", "Verified report", "--public");
  expect(added.code).toBe(0);
  expect(added.err).toBe("");
  const entry = f.artifacts.read(f.lane.key)[0];
  expect(entry).toBeDefined();
  const id = entry?.id ?? "",
    hash = entry?.versions[0]?.sha256 ?? "";
  const checkpoint = invoke(
    "checkpoint",
    f.lane.key,
    "--step",
    "screen",
    "--result",
    "checked",
    "--evidence",
    "test transcript",
    "--artifact",
    id,
    "--artifact",
    id,
  );
  expect(checkpoint.code).toBe(0);
  expect(new Checkpoints(f.config.stateDir).read(f.lane.key)[0]?.evidence).toEqual([
    "test transcript",
    `artifact:${id}@sha256:${hash}`,
  ]);
  const inventory = invoke("artifacts", f.lane.key, "--json");
  expect(inventory.code).toBe(0);
  expect(inventory.err).toBe("");
  expect(JSON.parse(inventory.out)).toMatchObject([
    { id, state: "current", checkpoints: [{ step: "screen", evidence: `artifact:${id}@sha256:${hash}` }] },
  ]);
  const report = invoke("report", f.lane.key, "--kind", "done", "--text", "Complete");
  expect(report.code).toBe(0);
  expect(report.err).toBe("");
  expect(report.out).toContain("https://files.example/reports/report.txt");
  expect(report.out).toContain(`sha256=${hash}`);
  expect(report.out).toContain("checkpoints=1");
  expect(report.out).not.toContain(f.root);
  const delivered = invoke(
    "artifact",
    "delivered",
    f.lane.key,
    id,
    "--sha256",
    hash,
    "--receipt",
    "discord:thread/message",
  );
  expect(delivered.code).toBe(0);
  expect(delivered.err).toBe("");
  const text = invoke("artifacts", f.lane.key);
  expect(text.code).toBe(0);
  expect(text.out).toContain("delivery=operator-reported");
  expect(text.out).toContain("HTTP=not-checked viewed=unknown");
});
test("unchanged checkpoint replay is idempotent and changed bytes cannot replace its original evidence", () => {
  expect(invoke("artifact", "add", f.lane.key, f.path).code).toBe(0);
  const id = f.artifacts.read(f.lane.key)[0]?.id ?? "";
  const args = [
    "checkpoint",
    f.lane.key,
    "--step",
    "verified",
    "--result",
    "checked",
    "--evidence",
    "transcript",
    "--artifact",
    id,
  ];
  const first = invoke(...args);
  expect(first.code).toBe(0);
  const stored = new Checkpoints(f.config.stateDir).read(f.lane.key);
  const replay = invoke(...args);
  expect(replay.code).toBe(0);
  expect(JSON.parse(replay.out).unchanged).toBe(true);
  writeFileSync(f.path, "changed bytes");
  expect(invoke(...args).code).toBe(1);
  expect(new Checkpoints(f.config.stateDir).read(f.lane.key)).toEqual(stored);
  expect(invoke("artifact", "add", f.lane.key, f.path).code).toBe(0);
  expect(invoke(...args).code).toBe(1);
  expect(new Checkpoints(f.config.stateDir).read(f.lane.key)).toEqual(stored);
});

test("corrupt artifact evidence refuses a done report but does not stop ordinary progress reporting", () => {
  expect(invoke("artifact", "add", f.lane.key, f.path, "--public").code).toBe(0);
  writeFileSync(f.artifacts.path(f.lane.key), "{");
  const done = invoke("report", f.lane.key, "--kind", "done", "--text", "Complete");
  expect(done.code).toBe(1);
  expect(done.out).toBe("");
  expect(done.err).toContain("artifact index contains invalid JSON");
  const progress = invoke("report", f.lane.key, "--kind", "blocker", "--text", "Repairing artifact index");
  expect(progress.code).toBe(0);
  expect(progress.out).toContain("Repairing artifact index");
});

test("changed public bytes are visible locally but their stale URL is withheld from the final report", () => {
  expect(invoke("artifact", "add", f.lane.key, f.path, "--public").code).toBe(0);
  const hash = f.artifacts.read(f.lane.key)[0]?.versions[0]?.sha256;
  writeFileSync(f.path, "modified after registration");
  const list = invoke("artifacts", f.lane.key);
  expect(list.code).toBe(0);
  expect(list.out).toContain(" changed");
  expect(list.out).toContain(`registered-sha256=${hash}`);
  const report = invoke("report", f.lane.key, "--kind", "done", "--text", "Complete");
  expect(report.code).toBe(0);
  expect(report.out).toContain("public link withheld");
  expect(report.out).not.toContain("https://files.example/");
  expect(report.out).not.toContain(f.path);
});
test("private titles and file paths are never copied to the final report", () => {
  expect(invoke("artifact", "add", f.lane.key, f.path, "--title", "Internal analysis").code).toBe(0);
  const report = invoke("report", f.lane.key, "--kind", "done", "--text", "Complete");
  expect(report.code).toBe(0);
  expect(report.out).toContain("Private artifacts omitted: 1");
  expect(report.out).not.toContain("Internal analysis");
  expect(report.out).not.toContain(f.root);
  expect(report.out).not.toContain("https://files.example/");
});
test.each(["--public=false", "--public=true", "--public=0", "--public="])(
  "publication requires an explicit bare boolean flag: %s",
  (flag) => {
    const result = invoke("artifact", "add", f.lane.key, f.path, flag);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--public does not take a value");
    expect(f.artifacts.read(f.lane.key)).toEqual([]);
  },
);

test.each(["--json=false", "--json=0"])("inventory requires an explicit bare boolean flag: %s", (flag) => {
  const result = invoke("artifacts", f.lane.key, flag);
  expect(result.code).toBe(1);
  expect(result.err).toContain("--json does not take a value");
});

test("invalid registration fails as one sanitized line and does not fall through to CLI help", () => {
  const result = invoke("artifact", "add", f.lane.key, join(f.state.dir, "outside.txt"), "--public");
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err.trim().split("\n")).toHaveLength(1);
  expect(result.err).toContain("configured containing root");
  expect(result.err).not.toContain(f.state.dir);
  expect(invoke("artifact", "add", f.lane.key, f.path, "stray").code).toBe(1);
  expect(invoke("artifacts", f.lane.key, "stray").code).toBe(1);
});
test("closed lane inventory and late delivery remain usable, but registration is refused", async () => {
  expect(invoke("artifact", "add", f.lane.key, f.path).code).toBe(0);
  const entry = f.artifacts.read(f.lane.key)[0];
  await f.registry.write(withStatus(f.lane, "closed", "done", new Date().toISOString()));
  expect(invoke("artifacts", f.lane.key).code).toBe(0);
  expect(invoke("artifact", "add", f.lane.key, f.path).code).toBe(1);
  expect(
    invoke(
      "artifact",
      "delivered",
      f.lane.key,
      entry?.id ?? "",
      "--sha256",
      entry?.versions[0]?.sha256 ?? "",
      "--receipt",
      "message:late",
    ).code,
  ).toBe(0);
});
