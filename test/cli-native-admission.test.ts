import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { nativeCacheFixture, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a lightweight command in a consumer release still validates every native byte before handler loading", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dori-cli-native-")));
  roots.push(home);
  const source = join(home, ".dori/releases/releases", `${"a".repeat(40)}-${"b".repeat(16)}`);
  const root = resolve(import.meta.dir, "..");
  const f = overlayFixture(source, join(home, "upstream"), true);
  for (const tree of ["src", "skills/dori-mode/scripts/src"])
    cpSync(join(root, tree), join(source, tree), { recursive: true });
  cpSync(join(root, "package.json"), join(source, "package.json"));
  const receipt = nativeCacheFixture(source, home, f.checkout);
  const manifests = join(home, ".dori/releases/consumer-manifests");
  mkdirSync(manifests, { recursive: true, mode: 0o700 });
  writeFileSync(join(manifests, `${basename(source)}.json`), JSON.stringify({ requirements: { omp: "18.20.0" } }), {
    mode: 0o600,
  });
  const state = join(home, "state");
  mkdirSync(join(state, "lanes"), { recursive: true });
  writeFileSync(join(state, "lanes/fixture.json"), JSON.stringify({ key: "fixture", status: "working" }));
  const config = join(home, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ runtime: "herdr", stateDir: state, agentCommand: ["omp"], ompUlwPath: "/explicit-ulw" }),
  );
  const cli = join(source, "skills/dori-mode/scripts/src/cli.ts");
  const invoke = (preload?: string) =>
    Bun.spawnSync([process.execPath, ...(preload ? ["--preload", preload] : []), cli, "checkpoints", "fixture"], {
      env: { HOME: home, PATH: process.env["PATH"], DORI_CONFIG: config, DORI_TELEMETRY: "0", DO_NOT_TRACK: "1" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    });
  const valid = invoke();
  expect({ code: valid.exitCode, out: valid.stdout.toString(), err: valid.stderr.toString() }).toEqual({
    code: 0,
    out: "[]\n",
    err: "",
  });
  writeFileSync(receipt.addon, "tampered native bytes");
  const preload = join(home, "handler-guard.ts");
  // The loader trap proves that native admission rejects drift before the lightweight handler is even loaded.
  writeFileSync(
    preload,
    `import { plugin } from "bun";
plugin({ name: "handler-guard", setup(build) {
  build.onLoad({ filter: /cli-journal[.]ts$/ }, () => { throw new Error("HANDLER_LOADED_BEFORE_ADMISSION"); });
} });`,
  );
  const invalid = invoke(preload);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr.toString()).toContain("receipt differs");
  expect(invalid.stderr.toString()).not.toContain("HANDLER_LOADED_BEFORE_ADMISSION");
  expect(invalid.stdout.toString()).toBe("");
});
