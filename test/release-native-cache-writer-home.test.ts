import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keptFor, pruneFixture, removePruneFixtures } from "./native-cache-prune-setup.ts";

afterEach(removePruneFixtures);

/**
 * A running Dori writer started with `words` and environment HOME `home`: a real process, so the reader of its
 * environment (Linux /proc, macOS KERN_PROCARGS2) is what judges it, not its arguments.
 */
async function writer(root: string, home: string, words: readonly string[]) {
  const bin = join(root, `bin-${Bun.hash(home)}-${Bun.hash(words.join(" "))}`);
  mkdirSync(bin, { recursive: true });
  // The child stays alive until its stdin closes (the test kills it first).
  writeFileSync(join(bin, "dori"), 'console.log("up");\nawait Bun.stdin.text();\n');
  const child = Bun.spawn([process.execPath, join(bin, "dori"), ...words], {
    env: { HOME: home, PATH: process.env["PATH"] },
    stdin: "pipe",
    stdout: "pipe",
  });
  await child.stdout.getReader().read();
  return child;
}

const unix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");
const uid = process.getuid?.() ?? 0;

unix("a Dori update writer keeps every identity only for the cache under its own HOME", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  const elsewhere = join(c.root, "other-home");
  mkdirSync(elsewhere);
  const other = await writer(c.root, elsewhere, ["update", "install"]);
  const own = await writer(c.root, c.home, ["update", "install"]);
  try {
    const row = (pid: number) => `${pid} ${uid} bun /x/bin/dori update install\n`;
    const unrelated = c.prune({ table: () => row(other.pid) });
    expect(keptFor(unrelated, x.directory) ?? []).not.toContain(expect.stringContaining("Dori cache writer"));
    expect(unrelated.quarantined.map((entry) => entry.directory)).toEqual([x.directory]);
    const held = c.prune({ table: () => row(own.pid) });
    expect(keptFor(held, x.directory)).toEqual(expect.arrayContaining([expect.stringContaining("Dori cache writer")]));
  } finally {
    other.kill();
    own.kill();
  }
});

// A relative HOME names a directory only against the writer's own working directory, which the pruner does not read.
unix("a Dori update writer with a relative HOME keeps every identity", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  // From the pruner's working directory this resolves to an existing directory other than the cache's home.
  const relative = "other-relative-home";
  mkdirSync(resolve(relative), { recursive: true });
  const writerProcess = await writer(c.root, relative, ["update", "install"]);
  try {
    const held = c.prune({ table: () => `${writerProcess.pid} ${uid} bun /x/bin/dori update install\n` });
    expect(keptFor(held, x.directory)).toEqual(expect.arrayContaining([expect.stringContaining("Dori cache writer")]));
  } finally {
    writerProcess.kill();
    rmSync(resolve(relative), { recursive: true, force: true });
  }
});

// A deployment provisions under its config's `home` (deployment-toolchain.ts), not the HOME it inherited.
unix("a Dori upstream writer keeps every identity whatever HOME it inherited", async () => {
  const c = pruneFixture();
  const x = c.native("x");
  const inherited = join(c.root, "inherited-home");
  mkdirSync(inherited);
  const config = join(c.root, "update.json");
  writeFileSync(config, JSON.stringify({ promotion: { deployment: { home: c.home } } }));
  const watch = await writer(c.root, inherited, ["upstream", "watch", "--config", config]);
  try {
    const args = `bun /x/bin/dori upstream watch --config ${config}`;
    const held = c.prune({ table: () => `${watch.pid} ${uid} ${args}\n` });
    expect(keptFor(held, x.directory)).toEqual(
      expect.arrayContaining([`Dori cache writer process ${watch.pid} (${args})`]),
    );
    expect(held.quarantined).toEqual([]);
  } finally {
    watch.kill();
  }
});

// launchd and test fixtures can start Dori with a PATH that has no /usr/sbin, where macOS keeps lsof.
test.skipIf(process.platform !== "darwin")("macOS process readers find lsof without /usr/sbin on PATH", () => {
  const code = `
    const { processCwds } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/process-cwd.ts"))});
    const { processFiles } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/release/process-files.ts"))});
    const pid = String(process.pid);
    console.log(JSON.stringify([processCwds([pid])?.cwds.get(pid) ?? null, processFiles()?.files.has(pid) ?? null]));`;
  const child = Bun.spawnSync([process.execPath, "-e", code], { env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
  expect(child.stderr.toString()).toBe("");
  expect(JSON.parse(child.stdout.toString())).toEqual(["/", true]);
});
