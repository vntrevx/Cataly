import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Artifacts } from "../src/artifacts.ts";
import { Checkpoints } from "../src/checkpoints.ts";
import { withStatus } from "../src/registry.ts";
import { ARTIFACT_NOW as now, artifactFixture } from "./artifact-fixture.ts";

let f: Awaited<ReturnType<typeof artifactFixture>>;
beforeEach(async () => {
  f = await artifactFixture();
});
afterEach(() => f.state.done());
const add = (visibility: "private" | "public" = "private") =>
  f.artifacts.add(f.lane.key, f.path, "Report", visibility, now);

test("registration is private, durable, mode 600, idempotent and restart-readable", async () => {
  const first = await add();
  expect(first.unchanged).toBe(false);
  expect(first.artifact.versions[0]).toMatchObject({
    title: "Report",
    visibility: "private",
    url: null,
    at: new Date(now).toISOString(),
  });
  expect((await add()).unchanged).toBe(true);
  expect(new Artifacts(f.config, f.registry).read(f.lane.key)).toEqual([first.artifact]);
  expect(statSync(f.artifacts.path(f.lane.key)).mode & 0o777).toBe(0o600);
  expect(first.artifact.receipts).toEqual([]);
});
test("same path keeps its id and immutable delivered hash when current content changes", async () => {
  const first = (await add("public")).artifact;
  const hash = first.versions[0]?.sha256 ?? "";
  expect(f.artifacts.delivered(f.lane.key, first.id, hash, "discord:channel/message", now).unchanged).toBe(false);
  expect(f.artifacts.delivered(f.lane.key, first.id, hash, "discord:channel/message", now + 1).unchanged).toBe(true);
  writeFileSync(f.path, "second version\n");
  const view = (await f.artifacts.views(f.lane.key))[0];
  expect(view?.state).toBe("changed");
  expect(view?.current?.sha256).not.toBe(hash);
  expect(view?.receipts).toEqual([
    { sha256: hash, reference: "discord:channel/message", at: new Date(now).toISOString(), kind: "operator-reported" },
  ]);
  const second = (await f.artifacts.add(f.lane.key, f.path, "Updated report", "public", now + 10)).artifact;
  expect(second.id).toBe(first.id);
  expect(second.createdAt).toBe(first.createdAt);
  expect(second.versions).toHaveLength(2);
  expect(second.versions[0]).toEqual(first.versions[0]);
  expect(second.receipts[0]?.sha256).not.toBe(second.versions[1]?.sha256);
});
test("publication changes are explicit immutable registrations, not inferred from a matching hash", async () => {
  const first = (await add()).artifact;
  const publicVersion = (await add("public")).artifact;
  expect(publicVersion.id).toBe(first.id);
  expect(publicVersion.versions).toHaveLength(2);
  expect(publicVersion.versions[0]?.url).toBeNull();
  expect(publicVersion.versions[1]?.url).toBe("https://files.example/reports/report.txt");
  expect((await add()).artifact.versions.at(-1)?.visibility).toBe("private");
});
test("configuration changes do not silently publish a new mapping", async () => {
  await add("public");
  const changed = new Artifacts(
    { ...f.config, artifactRoots: [{ path: f.root, baseUrl: "https://different.example/" }] },
    f.registry,
  );
  expect((await changed.views(f.lane.key))[0]?.state).toBe("changed");
  const disabled = new Artifacts({ ...f.config, artifactRoots: [] }, f.registry);
  expect((await disabled.views(f.lane.key))[0]?.state).toBe("unavailable");
});
test("delivery requires a known hash, never invents viewing, and works after close", async () => {
  const entry = (await add()).artifact;
  expect(() => f.artifacts.delivered(f.lane.key, entry.id, "0".repeat(64), "receipt", now)).toThrow(
    "registered artifact version",
  );
  expect(() =>
    f.artifacts.delivered(f.lane.key, entry.id, entry.versions[0]?.sha256 ?? "", "bad\nreceipt", now),
  ).toThrow("control characters");
  await f.registry.write(withStatus(f.lane, "closed", "done", new Date(now).toISOString()));
  await expect(add()).rejects.toThrow("open registered lane");
  const result = f.artifacts.delivered(f.lane.key, entry.id, entry.versions[0]?.sha256 ?? "", "message:123", now);
  expect(result.artifact.receipts[0]?.kind).toBe("operator-reported");
  expect(JSON.stringify(result)).not.toContain("viewed");
});
test("checkpoint evidence binds a current registered hash and rejects modified bytes", async () => {
  const entry = (await add()).artifact;
  const evidence = await f.artifacts.evidence(f.lane.key, [entry.id, entry.id]);
  expect(evidence).toEqual([`artifact:${entry.id}@sha256:${entry.versions[0]?.sha256}`]);
  const checkpoints = new Checkpoints(f.config.stateDir);
  checkpoints.write(
    f.lane.key,
    { step: "verified", result: "verified bytes", evidence: ["test output", ...evidence], remoteEffects: [] },
    now,
  );
  writeFileSync(f.path, "changed after verification");
  await expect(f.artifacts.evidence(f.lane.key, [entry.id])).rejects.toThrow("changed or is unavailable");
  await expect(f.artifacts.evidence(f.lane.key, ["missing"])).rejects.toThrow("not registered");
  expect(checkpoints.read(f.lane.key)[0]?.evidence).toEqual(["test output", ...evidence]);
});
test("live writer locks are not stolen during long hashing, even past the normal stale interval", async () => {
  const release = f.artifacts.lock(f.lane.key, now);
  try {
    await expect(f.artifacts.add(f.lane.key, f.path, undefined, "private", now + 600_000)).rejects.toThrow(
      "active writer",
    );
  } finally {
    release();
  }
  expect((await add()).unchanged).toBe(false);
});
test.each([
  null,
  {},
  { schema: 2, key: "artifact-lane", artifacts: [] },
  { schema: 1, key: "wrong-lane", artifacts: [] },
  { schema: 1, key: "artifact-lane", artifacts: [{}] },
])("corrupt index is not replaced: %j", async (bad) => {
  await add();
  const path = f.artifacts.path(f.lane.key),
    raw = JSON.stringify(bad);
  writeFileSync(path, raw);
  await expect(add()).rejects.toThrow("invalid records");
  expect(readFileSync(path, "utf8")).toBe(raw);
});
test("individual damaged manifest fields cannot become plausible artifact records", async () => {
  const entry = (await add()).artifact;
  const version = entry.versions[0];
  if (!version) throw new Error("registered version missing");
  const bad = [
    { ...entry, id: "-".repeat(36) },
    { ...entry, path: "relative.txt" },
    { ...entry, createdAt: "invalid" },
    { ...entry, versions: [] },
    { ...entry, extra: true },
    ...[
      { size: -1 },
      { size: 1.5 },
      { sha256: "bad" },
      { visibility: "unknown" },
      { url: "https://not-public.example/" },
      { title: "bad\nname" },
      { realPath: "relative.txt" },
      { at: "2026-01-01" },
    ].map((change) => ({ ...entry, versions: [{ ...version, ...change }] })),
  ];
  for (const artifact of bad) {
    const raw = JSON.stringify({ schema: 1, key: f.lane.key, artifacts: [artifact] });
    writeFileSync(f.artifacts.path(f.lane.key), raw);
    expect(() => f.artifacts.read(f.lane.key)).toThrow("invalid records");
    expect(readFileSync(f.artifacts.path(f.lane.key), "utf8")).toBe(raw);
  }
});

test("malformed JSON, duplicate identities and unknown delivery hashes fail closed", async () => {
  const entry = (await add()).artifact;
  const path = f.artifacts.path(f.lane.key);
  for (const raw of [
    "{",
    JSON.stringify({ schema: 1, key: f.lane.key, artifacts: [entry, entry] }),
    JSON.stringify({
      schema: 1,
      key: f.lane.key,
      artifacts: [
        {
          ...entry,
          receipts: [
            {
              sha256: "0".repeat(64),
              reference: "unknown",
              at: new Date(now).toISOString(),
              kind: "operator-reported",
            },
          ],
        },
      ],
    }),
  ]) {
    writeFileSync(path, raw);
    expect(() => f.artifacts.read(f.lane.key)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(raw);
  }
});
