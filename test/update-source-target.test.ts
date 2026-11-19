import { expect, test } from "bun:test";
import type { GitHubReads } from "../src/update/github-ci.ts";
import { digest } from "../src/update/source.ts";
import { selectSourceTarget, verifySourceTarget } from "../src/update/source-update-target.ts";
import { githubFixture } from "./release-producer-setup.ts";
import { sourceFixture } from "./update-source-setup.ts";

function setup() {
  const source = sourceFixture();
  const f = githubFixture(source.config.repository);
  const current = {
    path: source.config.deployment.liveSource,
    commit: "0".repeat(40),
    tree: "f".repeat(40),
    sourceHash: digest("old source"),
  };
  f.responses[`${f.prefix}/git/commits/${f.manifest.commit}`] = {
    sha: f.manifest.commit,
    tree: { sha: f.manifest.tree },
    parents: [{ sha: current.commit }],
  };
  const comparison = `${f.prefix}/compare/${current.commit}...${f.manifest.commit}`;
  f.responses[comparison] = {
    status: "ahead",
    ahead_by: 2,
    base_commit: { sha: current.commit },
    merge_base_commit: { sha: current.commit },
  };
  return { ...f, ...source, current, comparison };
}

test("source selects the first CI-passing main commit and never a consumer release tag", async () => {
  const f = setup();
  await expect(selectSourceTarget(f.config, f.current, f.reads)).resolves.toEqual({
    commit: f.manifest.commit,
    tree: f.manifest.tree,
    main: f.manifest.commit,
    ahead: 2,
    ci: { id: 70, attempt: 2 },
  });
  await expect(
    selectSourceTarget(f.config, { ...f.current, commit: f.manifest.commit, tree: f.manifest.tree }, f.reads),
  ).resolves.toMatchObject({ ahead: 0, ci: { id: 70, attempt: 2 } });
});

for (const status of ["absent", "failure"] as const)
  test(`source walks first parents past known ${status} CI`, async () => {
    const f = setup();
    const head = "3".repeat(40);
    f.responses[`${f.prefix}/branches/main`] = { commit: { sha: head } };
    f.responses[`${f.prefix}/git/commits/${head}`] = {
      sha: head,
      tree: { sha: "4".repeat(40) },
      parents: [{ sha: f.manifest.commit }],
    };
    const failed = { ...f.run, head_sha: head, id: 71, conclusion: "failure" };
    f.responses[`${f.prefix}/actions/runs/71`] = failed;
    const reads: GitHubReads = {
      ...f.reads,
      pages: (path, collection) =>
        path.includes(`head_sha=${head}`)
          ? Promise.resolve(status === "absent" ? [] : [failed])
          : f.reads.pages(path, collection),
    };
    await expect(selectSourceTarget(f.config, f.current, reads)).resolves.toMatchObject({
      commit: f.manifest.commit,
      main: head,
    });
  });

test("source does not turn unavailable or foreign CI evidence into an older successful candidate", async () => {
  const f = setup();
  const unavailable = new Error("recorded transport failure");
  await expect(
    selectSourceTarget(f.config, f.current, {
      ...f.reads,
      pages: async () => {
        throw unavailable;
      },
    }),
  ).rejects.toBe(unavailable);
  f.run["head_repository"] = { full_name: "foreign/Cataly" };
  await expect(selectSourceTarget(f.config, f.current, f.reads)).rejects.toThrow("own main ci.yml");
});

for (const status of ["behind", "diverged"])
  test(`source rejects a ${status} installed checkout instead of resetting it`, async () => {
    const f = setup();
    f.responses[f.comparison] = { status };
    await expect(selectSourceTarget(f.config, f.current, f.reads)).rejects.toThrow("forward ancestor-bound");
  });

test("source compares the exact installed base rather than trusting an ahead label", async () => {
  const f = setup();
  f.responses[f.comparison] = {
    status: "ahead",
    ahead_by: 2,
    base_commit: { sha: f.current.commit },
    merge_base_commit: { sha: "f".repeat(40) },
  };
  await expect(selectSourceTarget(f.config, f.current, f.reads)).rejects.toThrow("forward ancestor-bound");
  await expect(selectSourceTarget(f.config, { ...f.current, commit: f.manifest.commit }, f.reads)).rejects.toThrow(
    "trees differ",
  );
});

test("source refuses a selection if main changes while its CI is being verified", async () => {
  const f = setup();
  let heads = 0;
  const reads: GitHubReads = {
    ...f.reads,
    api: (path) => {
      if (path === `${f.prefix}/branches/main` && ++heads > 1)
        return Promise.resolve({ commit: { sha: "3".repeat(40) } });
      return f.reads.api(path);
    },
  };
  await expect(selectSourceTarget(f.config, f.current, reads)).rejects.toThrow("main changed");
});

test("source bounds invalid first-parent histories and does not loop on a cycle", async () => {
  const f = setup();
  f.runs.length = 0;
  f.responses[`${f.prefix}/git/commits/${f.manifest.commit}`] = {
    sha: f.manifest.commit,
    tree: { sha: f.manifest.tree },
    parents: [{ sha: f.manifest.commit }],
  };
  await expect(selectSourceTarget(f.config, f.current, f.reads)).rejects.toThrow("cycle");
  await expect(selectSourceTarget(f.config, { ...f.current, commit: f.manifest.commit }, f.reads)).rejects.toThrow(
    "no passing forward main target",
  );
});

test("source rechecks the exact target CI before stop without selecting a replacement mid-transaction", async () => {
  const f = setup();
  const target = await selectSourceTarget(f.config, f.current, f.reads);
  await expect(verifySourceTarget(f.config, target, f.reads)).resolves.toEqual({ id: 70, attempt: 2 });
  f.jobs[0]!["conclusion"] = "failure";
  await expect(verifySourceTarget(f.config, target, f.reads)).rejects.toThrow("did not succeed");
});

test("source revokes a prepared target after canonical repository or main ancestry changes", async () => {
  const f = setup();
  const target = await selectSourceTarget(f.config, f.current, f.reads);
  const head = "3".repeat(40);
  f.responses[`${f.prefix}/branches/main`] = { commit: { sha: head } };
  f.responses[`${f.prefix}/compare/${target.commit}...${head}`] = { status: "diverged" };
  await expect(verifySourceTarget(f.config, target, f.reads)).rejects.toThrow("forward ancestor-bound");
  f.responses[f.prefix] = { full_name: "another/Cataly" };
  await expect(verifySourceTarget(f.config, target, f.reads)).rejects.toThrow("canonical identity");
});
