import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { automaticUpdate } from "../src/release/automatic.ts";
import { readAutomaticState } from "../src/release/automatic-state.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { consumerConfigPlan, previewConsumerSetup } from "../src/release/setup.ts";
import { loadInstalled, releasePath } from "../src/release/state.ts";
import { captureSetupFile } from "../src/setup-files.ts";
import { setupReadback } from "../src/setup-readback.ts";
import { digest } from "../src/update/source.ts";
import { portableFixture as fixture } from "./release-consumer-setup.ts";

const supported =
  (process.platform === "linux" && process.arch === "x64") ||
  (process.platform === "darwin" && process.arch === "arm64");

test.each([false, true])(
  "consumer preview predicts exact new configuration without preparing or activating it (side=%s)",
  async (side) => {
    const f = fixture(side);
    const release = f.release("preview");
    const before = captureSetupFile(f.paths.config);
    const dependencies = readdirSync(f.paths.dependencies);
    const preview = previewConsumerSetup(f.paths, release.bundle, before);
    expect(preview.action).toBe("create");
    expect(captureSetupFile(f.paths.config)).toEqual(before);
    expect(readdirSync(f.paths.dependencies)).toEqual(dependencies);
    expect(readdirSync(f.paths.releases)).toEqual([]);
    expect(readdirSync(f.paths.manifests)).toEqual([]);
    expect(loadInstalled(f.paths)).toBeUndefined();
    expect(existsSync(f.paths.live)).toBe(false);
    await installBundle(f.paths, release.bundle, undefined);
    expect(digest(readFileSync(f.paths.config))).toBe(preview.afterSha256);
  },
);

test("consumer install preview uses the real CLI without creating its selected home", () => {
  const f = fixture();
  const release = f.release("cli-preview");
  const selected = join(f.paths.home, "preview-only");
  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/release/cli.ts"),
      "install",
      "--preview",
      "--from",
      release.dist,
      "--home",
      selected,
    ],
    {
      env: { ...process.env, DORI_CONFIG: join(selected, "config.json"), DORI_HOME: selected },
    },
  );
  expect(existsSync(selected)).toBe(false);
  if (!supported) {
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("Unsupported release host/runtime");
    return;
  }
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    preview: true,
    configuration: { action: "create", path: join(selected, "config.json") },
  });
  expect(result.stdout.toString()).not.toContain('"installed"');
});

test("consumer setup preserves existing bytes and reports effective overrides without exposing values", async () => {
  const f = fixture();
  const text =
    '{ "runtime":"herdr", "stateDir":"/owner/custom-state", "defaultModel":"owner/private-model", "unknown":{"secret":"private-value"} }\n';
  writeFileSync(f.paths.config, text, { mode: 0o640 });
  const before = captureSetupFile(f.paths.config);
  const release = f.release("preserve");
  expect(previewConsumerSetup(f.paths, release.bundle, before)).toMatchObject({
    action: "preserve",
    beforeSha256: digest(text),
    afterSha256: digest(text),
  });
  await installBundle(f.paths, release.bundle, undefined);
  expect(captureSetupFile(f.paths.config)).toEqual(before);
  const readback = await setupReadback(before, "consumer-updater-reader", { path: f.paths.config, home: f.paths.home });
  expect(readback).toMatchObject({ saved: true, effective: "shadowed", overridden: ["stateDir"] });
  expect(JSON.stringify(readback)).not.toContain("private-value");
  expect(JSON.stringify(readback)).not.toContain("private-model");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
});

test("consumer preview, install and rollback retain non-UTF-8 configuration bytes", async () => {
  const f = fixture();
  const bytes = Buffer.concat([Buffer.from('{"runtime":"herdr","owner":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  writeFileSync(f.paths.config, bytes, { mode: 0o600 });
  const snapshot = captureSetupFile(f.paths.config);
  const first = f.release("byte-preserving-one");
  expect(previewConsumerSetup(f.paths, first.bundle, snapshot)).toMatchObject({
    action: "preserve",
    beforeSha256: digest(bytes),
    afterSha256: digest(bytes),
  });
  const one = await installBundle(f.paths, first.bundle, undefined);
  const two = await installBundle(f.paths, f.release("byte-preserving-two").bundle, one);
  await rollbackRelease(f.paths, two);
  expect(readFileSync(f.paths.config)).toEqual(bytes);
  expect(captureSetupFile(f.paths.config)).toEqual(snapshot);
});

test("consumer preparation refuses an owner-created config instead of treating it as its original input", async () => {
  const f = fixture();
  const release = f.release("created-during-preparation");
  const installing = installBundle(f.paths, release.bundle, undefined);
  const text = '{"runtime":"herdr","owner":"concurrent creator"}\n';
  writeFileSync(f.paths.config, text, { mode: 0o600 });
  await expect(installing).rejects.toThrow("Configuration changed during setup");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(loadInstalled(f.paths)).toBeUndefined();
});

test("consumer activation rechecks configuration after its final callback", async () => {
  const f = fixture();
  const before = await installBundle(f.paths, f.release("one").bundle, undefined);
  const pointer = readlinkSync(f.paths.live);
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  await expect(
    installBundle(f.paths, f.release("two").bundle, before, {
      beforeActivate: () => {
        writeFileSync(f.paths.config, text);
      },
    }),
  ).rejects.toThrow("Configuration changed during setup");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(loadInstalled(f.paths)).toEqual(before);
});

test("rollback holds a config edit made while retained dependencies are verified", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const two = await installBundle(f.paths, f.release("two").bundle, one);
  const rolling = rollbackRelease(f.paths, two);
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  writeFileSync(f.paths.config, text);
  await expect(rolling).rejects.toThrow("Configuration changed during setup");
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(loadInstalled(f.paths)).toEqual(two);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, two.current));
});

test("automatic acquisition cannot activate using a configuration changed during its download", async () => {
  const f = fixture();
  const first = f.release("one").bundle;
  const before = await installBundle(
    f.paths,
    { ...first, manifest: { ...first.manifest, prerelease: false } },
    undefined,
  );
  const next = f.release("two").bundle;
  const text = `${readFileSync(f.paths.config, "utf8")}\n`;
  let downloaded = false;
  const source = await automaticUpdate(f.paths, {
    now: 10_000,
    checkTools: () => {},
    acquire: async () => {
      downloaded = true;
      writeFileSync(f.paths.config, text);
      return { ...next, manifest: { ...next.manifest, prerelease: false } };
    },
  });
  expect(downloaded).toBe(true);
  expect(source).toBe(releasePath(f.paths, before.current));
  expect(loadInstalled(f.paths)).toEqual(before);
  expect(readFileSync(f.paths.config, "utf8")).toBe(text);
  expect(readAutomaticState(f.paths).detail).toContain("Configuration changed during setup");
});

test("a consumer plan cannot publish another home's snapshot", () => {
  const f = fixture();
  const foreign = join(f.paths.home, "foreign.json");
  writeFileSync(foreign, "{}\n", { mode: 0o600 });
  expect(() => consumerConfigPlan(f.paths, captureSetupFile(foreign), f.root, f.ownedDependency, false)).toThrow(
    "another installation",
  );
  expect(readFileSync(foreign, "utf8")).toBe("{}\n");
});
