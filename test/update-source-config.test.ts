import { expect, test } from "bun:test";
import { chmodSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { loadSourceUpdateConfig, sourceRequiredCi } from "../src/update/source-update-config.ts";
import { sourceFixture } from "./update-source-setup.ts";

const checks = ["check", "e2e-herdr", "e2e-hc"];
test("source configuration opts into daily, thirty-minute, draft-aware updates without creating deployment state", () => {
  const f = sourceFixture();
  expect(f.config.repository).toBe("vntrevx/Cataly");
  expect(f.config.intervalSeconds).toBe(86_400);
  expect(f.config.ownerQuietMs).toBe(1_800_000);
  expect(f.config.activityMaxAgeMs).toBe(120_000);
  expect(f.config.requiredCi).toEqual(checks);
  expect(f.config.deployment.nativeStopMode).toBe("ui");
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
});

const invalid: Record<string, unknown>[] = [
  { ownerQuietMinutes: 29 },
  { ownerQuietMinutes: 30.5 },
  { intervalSeconds: 0 },
  { activityMaxAgeSeconds: 301 },
  { activityFiles: [] },
  { activityFiles: ["outside.json"] },
  { requiredCi: ["check", "e2e-herdr"] },
  { requiredCi: [...checks, "check"] },
  { repository: "https://github.com/vntrevx/Cataly" },
  { version: 2 },
  { surprise: true },
];
for (const change of invalid)
  test(`source configuration rejects unsafe settings ${JSON.stringify(change)}`, () => {
    const f = sourceFixture();
    saveDeploymentJson(f.path, { ...f.settings, ...change });
    expect(() => loadSourceUpdateConfig(f.path)).toThrow();
  });

test("source configuration cannot opt out of draft-aware stop or count duplicate receivers", () => {
  const f = sourceFixture();
  saveDeploymentJson(f.path, { ...f.settings, deployment: { ...f.settings.deployment, nativeStopMode: "signal" } });
  expect(() => loadSourceUpdateConfig(f.path)).toThrow("UI stop");
  saveDeploymentJson(f.path, {
    ...f.settings,
    activityFiles: [...f.settings.activityFiles, ...f.settings.activityFiles],
  });
  expect(() => loadSourceUpdateConfig(f.path)).toThrow("distinct paths");
});

test("source configuration rejects unprotected and linked opt-in files", () => {
  const f = sourceFixture();
  chmodSync(f.path, 0o666);
  expect(() => loadSourceUpdateConfig(f.path)).toThrow("owned protected");
  chmodSync(f.path, 0o600);
  const link = join(f.root, "linked-config.json");
  symlinkSync(f.path, link);
  expect(() => loadSourceUpdateConfig(link)).toThrow("owned protected");
  expect(sourceRequiredCi([...checks, "extra-job"])).toEqual([...checks, "extra-job"]);
});
