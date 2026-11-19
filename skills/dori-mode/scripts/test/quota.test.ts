import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuota, readQuota, renderQuota } from "../src/quota.ts";
import type { Runner } from "../src/run.ts";
import { usageOptionsError } from "../src/usage-options.ts";
import { usageFixture, USAGE_NOW } from "./usage-fakes.ts";

let f: ReturnType<typeof usageFixture>;
beforeEach(() => {
  f = usageFixture();
});
afterEach(() => f.done());
const payload = () => ({
  generatedAt: USAGE_NOW,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: USAGE_NOW,
      metadata: { email: "account@example.test" },
      raw: { accessToken: "PRIVATE_CREDENTIAL" },
      limits: [
        {
          label: "5 hours",
          window: { durationMs: 18_000_000, resetsAt: USAGE_NOW + 60_000 },
          amount: { usedFraction: 0.8 },
          status: "ok",
        },
        { label: "weekly", window: { durationMs: 604_800_000 }, amount: { used: 25, unit: "percent" } },
      ],
    },
  ],
  accountsWithoutUsage: [{ provider: "openai-codex", accountId: "unavailable-account" }],
  disabledCredentials: [{ provider: "anthropic", email: "disabled@example.test" }],
  capacity: { resetCredits: "PRIVATE_CREDIT_DATA" },
});

test("quota reads only usage --json, caches normalized observations and refresh is explicit", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: JSON.stringify(payload()), err: "" };
  };
  const config = { ...f.config, quota: { warnUsedPercent: 90 } };
  const first = await readQuota(config, run, USAGE_NOW);
  expect(first.stale).toBe(false);
  expect(calls).toEqual([["omp", "usage", "--json"]]);
  expect((await readQuota(config, run, USAGE_NOW + 1000)).accounts).toEqual(first.accounts);
  expect(calls).toHaveLength(1);
  await readQuota(config, run, USAGE_NOW + 2000, true);
  expect(calls).toHaveLength(2);
  const text = renderQuota(first);
  expect(text).toContain("80.0%");
  expect(text).toContain("25.0%");
  expect(text).toContain("display-headroom=10.0pp");
  expect(text).toContain("unavailable");
  expect(text).toContain("disabled");
  expect(text).toContain("5h missing");
  const cache = readFileSync(join(f.config.stateDir, "quota-cache.json"), "utf8");
  expect(cache).not.toContain("PRIVATE_CREDENTIAL");
  expect(cache).not.toContain("PRIVATE_CREDIT_DATA");
});

test("a successful refresh preserves the provider observation age even within native cache jitter", async () => {
  const source = payload();
  source.reports[0]!.fetchedAt = USAGE_NOW - 330_000;
  let calls = 0;
  const result = await readQuota(
    f.config,
    async () => {
      calls++;
      return { code: 0, out: JSON.stringify(source), err: "" };
    },
    USAGE_NOW,
    true,
  );
  expect(calls).toBe(1);
  expect(result.observedAt).toBe(USAGE_NOW);
  expect(result.generatedAt).toBe(USAGE_NOW);
  expect(result.accounts[0]?.fetchedAt).toBe(source.reports[0]!.fetchedAt);
  expect(result.stale).toBe(true);
  expect(renderQuota(result)).toContain(`observed=${new Date(source.reports[0]!.fetchedAt).toISOString()}`);
});

test("a failed query preserves stale provenance without a retry or a fabricated zero", async () => {
  await readQuota(f.config, async () => ({ code: 0, out: JSON.stringify(payload()), err: "" }), USAGE_NOW);
  let calls = 0;
  const result = await readQuota(
    f.config,
    async () => {
      calls++;
      return { code: 124, out: "", err: "PRIVATE_PROVIDER_ERROR" };
    },
    USAGE_NOW + 600_000,
  );
  expect(calls).toBe(1);
  expect(result.stale).toBe(true);
  expect(result.generatedAt).toBe(USAGE_NOW);
  expect(result.accounts[0]?.limits[0]?.usedFraction).toBe(0.8);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_ERROR");
  expect(result.errors[0]).toContain("no account switch or retry");
});

test("missing amounts and malformed source times remain unknown", () => {
  const data = parseQuota({
    generatedAt: USAGE_NOW,
    reports: [
      { provider: "fixture", fetchedAt: 1e100, limits: [{ label: "5h", window: { resetsAt: 1e100 }, amount: {} }] },
    ],
  });
  expect(data.accounts[0]?.fetchedAt).toBeNull();
  expect(data.accounts[0]?.limits[0]?.usedFraction).toBeNull();
  expect(data.accounts[0]?.limits[0]?.resetsAt).toBeNull();
  expect(() => parseQuota({ generatedAt: 1e100, reports: [] })).toThrow("invalid OMP usage JSON");
  expect(() => parseQuota({ generatedAt: USAGE_NOW, reports: [{}] })).toThrow();
});

test("corrupt normalized cache is discarded and malformed fresh output is not reported as zero", async () => {
  await readQuota(f.config, async () => ({ code: 0, out: JSON.stringify(payload()), err: "" }), USAGE_NOW);
  const path = join(f.config.stateDir, "quota-cache.json");
  const cached = JSON.parse(readFileSync(path, "utf8"));
  cached.data.accounts[0].limits = null;
  writeFileSync(path, JSON.stringify(cached));
  let calls = 0;
  const result = await readQuota(
    f.config,
    async () => {
      calls++;
      return { code: 0, out: "not-json", err: "" };
    },
    USAGE_NOW + 1000,
  );
  expect(calls).toBe(1);
  expect(result.stale).toBe(true);
  expect(result.generatedAt).toBeNull();
  expect(result.accounts).toEqual([]);
  expect(renderQuota(result)).toContain("not zero usage");
});

test("quota and built-in usage settings cannot silently change policy or discard a ceiling", () => {
  expect(usageOptionsError("omp", undefined, { command: ["omp"], cacheMinutes: 5, warnUsedPercent: 90 })).toBeNull();
  for (const quota of [
    { command: ["omp", "usage", "reset"] },
    { command: [] },
    { cacheMinutes: 0 },
    { warnUsedPercent: 101 },
    { rotateAccount: true },
  ])
    expect(usageOptionsError(undefined, undefined, quota)).not.toBeNull();
  expect(usageOptionsError("other", undefined, undefined)).not.toBeNull();
  expect(usageOptionsError("omp", ["external-reader"], undefined)).toContain("not both");
});

for (const [durationMs, windowId, present] of [
  [17_940_000, null, true],
  [18_000_001, null, true],
  [18_060_000, null, true],
  [null, "5h", true],
  [null, "5H", true],
  [null, "7d", true],
  [null, "7D", true],
  [17_939_999, null, false],
  [18_060_001, null, false],
] as const)
  test(`native window ${durationMs ?? windowId} has the reported coverage`, () => {
    const data = parseQuota({
      generatedAt: USAGE_NOW,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: USAGE_NOW,
          limits: [{ label: "primary", scope: { windowId }, window: { durationMs }, amount: { usedFraction: 0.25 } }],
        },
      ],
    });
    const text = renderQuota({ ...data, observedAt: USAGE_NOW, stale: false, errors: [], warnUsedPercent: null });
    expect(text.includes(windowId?.toLowerCase() === "7d" ? "weekly missing" : "5h missing")).toBe(!present);
  });
