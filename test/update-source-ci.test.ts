import { expect, test } from "bun:test";
import { MainCiNotReady, verifyMainCi } from "../src/update/github-ci.ts";
import { githubFixture } from "./release-producer-setup.ts";

const repository = "vntrevx/Cataly";
test("source CI checks the canonical renamed repository without release tags or versions", async () => {
  const f = githubFixture(repository);
  await expect(verifyMainCi(repository, f.manifest.commit, f.reads)).resolves.toEqual({ id: 70, attempt: 2 });
});

test("source CI never treats a foreign repository as its own successful main run", async () => {
  const f = githubFixture(repository);
  f.run["head_repository"] = { full_name: "another/Cataly" };
  await expect(verifyMainCi(repository, f.manifest.commit, f.reads)).rejects.toThrow("own main ci.yml");
});

test("source CI rejects copied check URLs and requires configured additional jobs", async () => {
  const f = githubFixture(repository);
  f.jobs[0]!["check_run_url"] = "https://api.github.com/repos/another/Cataly/check-runs/100";
  await expect(verifyMainCi(repository, f.manifest.commit, f.reads)).rejects.toThrow("did not succeed");
  const fresh = githubFixture(repository);
  await expect(verifyMainCi(repository, fresh.manifest.commit, fresh.reads, ["check", "manual-extra"])).rejects.toThrow(
    "missing or ambiguous: manual-extra",
  );
});

for (const change of [
  { head_sha: "3".repeat(40) },
  { run_id: 71 },
  { run_attempt: 3 },
  { check_run_url: "https://api.github.com/repos/foreign/Cataly/check-runs/100" },
])
  test(`source CI does not skip an untrusted job identity ${JSON.stringify(change)}`, async () => {
    const f = githubFixture(repository);
    Object.assign(f.jobs[0]!, change);
    const failure = await verifyMainCi(repository, f.manifest.commit, f.reads).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MainCiNotReady);
  });

for (const mismatchedRead of [1, 2])
  test(`source CI rejects an untrusted run identity at read ${mismatchedRead}`, async () => {
    const f = githubFixture(repository);
    let details = 0;
    const reads = {
      ...f.reads,
      api: (path: string) => {
        if (path === `${f.prefix}/actions/runs/70` && ++details === mismatchedRead)
          return Promise.resolve({ ...f.run, id: 71 });
        return f.reads.api(path);
      },
    };
    const failure = await verifyMainCi(repository, f.manifest.commit, reads).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MainCiNotReady);
  });

test("known CI incompletion is distinguishable from an unavailable GitHub read", async () => {
  const f = githubFixture(repository);
  f.runs.length = 0;
  await expect(verifyMainCi(repository, f.manifest.commit, f.reads)).rejects.toBeInstanceOf(MainCiNotReady);
  const unavailable = new Error("transport unavailable");
  await expect(
    verifyMainCi(repository, f.manifest.commit, {
      ...f.reads,
      api: async () => {
        throw unavailable;
      },
    }),
  ).rejects.toBe(unavailable);
});
