import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { git, script, setup, withUlwRemote } from "./install-setup.ts";

test.each(["primary", "side"] as const)("source %s setup creates a private home under umask 0002", (mode) => {
  const s = setup();
  const result = Bun.spawnSync(["bash", "-c", 'umask 0002; exec "$1"', "setup-umask", script], {
    env: s.env({ DORI_INSTALL_MODE: mode, DORI_NO_PULL: "1" }),
    stdin: "ignore",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const base = join(s.home, mode === "primary" ? ".dori" : ".omp-dori");
  expect(statSync(base).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, "config.json")).mode & 0o777).toBe(0o600);
  expect(s.install({ DORI_INSTALL_MODE: mode, DORI_NO_PULL: "1" }).code).toBe(0);
});

test.each(["custom-ulw", "backup"] as const)("source %s path creates a private home before preparation", (kind) => {
  const s = withUlwRemote();
  const extra: Record<string, string> = { DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1" };
  if (kind === "custom-ulw") {
    Object.assign(extra, { OMP_ULW_SRC: "", OMP_ULW_REPO: s.remote, OMP_ULW_REF: "main" });
  } else {
    const bin = join(s.home, "global-bin");
    mkdirSync(bin);
    symlinkSync(join(s.upstream, s.cli), join(bin, "dori"));
  }
  const result = Bun.spawnSync(["bash", "-c", 'umask 0002; exec "$1"', "setup-umask", script], {
    env: s.env(extra),
    stdin: "ignore",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const base = join(s.home, ".dori");
  expect(statSync(base).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, "config.json")).mode & 0o777).toBe(0o600);
  if (kind === "custom-ulw") expect(git(join(base, "omp-ulw-custom"), "rev-parse", "HEAD")).toBe(s.first);
  else expect(readdirSync(join(base, "backups"))).toHaveLength(1);
  expect(s.install(extra).code).toBe(0);
});

test.each(["directory", "file"] as const)(
  "unsafe existing %s permissions are held with a repair instruction",
  (kind) => {
    const s = setup();
    const base = join(s.home, ".dori");
    mkdirSync(base, { mode: 0o700 });
    const path = join(base, "config.json");
    writeFileSync(path, '{"owner":"retained"}\n', { mode: 0o600 });
    const target = kind === "directory" ? base : path;
    chmodSync(target, kind === "directory" ? 0o775 : 0o664);
    const before = statSync(target);
    const result = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("Group/world-writable");
    expect(result.err).toContain("chmod go-w");
    expect(result.err).toContain(target);
    expect(statSync(target).mode).toBe(before.mode);
    expect(readFileSync(path, "utf8")).toBe('{"owner":"retained"}\n');
  },
);

test("a source directory alias cannot retarget a captured configuration receipt", () => {
  const s = setup();
  const original = join(s.home, "original");
  const replacement = join(s.home, "replacement");
  const alias = join(s.home, "selected-alias");
  for (const base of [original, replacement]) {
    mkdirSync(base, { mode: 0o700 });
    writeFileSync(join(base, "config.json"), JSON.stringify({ owner: base }), { mode: 0o600 });
  }
  symlinkSync(original, alias);
  const helper = join(dirname(script), "source-configuration.ts");
  const capture = Bun.spawnSync([process.execPath, helper, "capture", alias, s.src, "side"], {
    env: s.env({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
  });
  expect(capture.exitCode, capture.stderr.toString()).toBe(0);
  unlinkSync(alias);
  symlinkSync(replacement, alias);
  const publish = Bun.spawnSync([process.execPath, helper, "publish-json", alias, s.src, "side"], {
    env: s.env({ DORI_SETUP_SNAPSHOT: capture.stdout.toString(), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }),
  });
  expect(publish.exitCode).toBe(1);
  expect(publish.stderr.toString()).toContain("snapshot does not belong");
  for (const base of [original, replacement])
    expect(readFileSync(join(base, "config.json"), "utf8")).toBe(JSON.stringify({ owner: base }));
});

test("source JSON with no managed change retains original non-UTF-8 bytes", () => {
  const s = setup();
  const base = join(s.home, ".dori");
  mkdirSync(base, { mode: 0o700 });
  const path = join(base, "config.json");
  const bytes = Buffer.concat([
    Buffer.from('{"ompUlwPath":"","agentCommand":["owner"],"owner":"'),
    Buffer.from([0xff]),
    Buffer.from('"}\n'),
  ]);
  writeFileSync(path, bytes, { mode: 0o600 });
  const inode = statSync(path).ino;
  const result = s.install({ DORI_INSTALL_MODE: "primary", DORI_NO_PULL: "1" });
  expect(result.code, result.err).toBe(0);
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).ino).toBe(inode);
});

test.each(["config.json", "omp.yml"] as const)("source refuses a lossy UTF-8 rewrite of %s", (name) => {
  const s = setup();
  const base = join(s.home, ".omp-dori");
  mkdirSync(base, { mode: 0o700 });
  const path = join(base, name);
  const bytes = Buffer.concat([
    Buffer.from(name === "config.json" ? '{"ompUlwPath":"stale","owner":"' : 'owner: "'),
    Buffer.from([0xff]),
    Buffer.from(name === "config.json" ? '"}\n' : '"\n'),
  ]);
  writeFileSync(path, bytes, { mode: 0o600 });
  const inode = statSync(path).ino;
  const result = s.install({ DORI_INSTALL_MODE: "side", DORI_NO_PULL: "1" });
  expect(result.code).toBe(1);
  expect(result.err).toContain("UTF-8");
  expect(readFileSync(path)).toEqual(bytes);
  expect(statSync(path).ino).toBe(inode);
});
