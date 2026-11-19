import type { Subprocess } from "bun";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";
import { coverageFixture, start } from "./supervision-coverage.fixture.ts";

let interrupted: Subprocess | undefined;
afterEach(() => {
  interrupted?.kill("SIGKILL");
  interrupted = undefined;
});

test("a discovered candidate survives process death during hashing and a commit before restart", async () => {
  const state = withState();
  try {
    const f = coverageFixture(state);
    await f.sweep();
    const discovered = join(f.scaffold, "!discovered.txt");
    writeFileSync(discovered, "discovered before interruption");
    const pauseAt = f.paths[256];
    if (!pauseAt) throw new Error("fixture needs the second window");
    const script = join(state.dir, "interrupted-observer.test.ts");
    writeFileSync(
      script,
      `
import { spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { Supervision } from ${JSON.stringify(new URL("../src/supervision.ts", import.meta.url).pathname)};
test("interrupt at the first candidate read", async () => {
  const open = fs.openSync;
  spyOn(fs, "openSync").mockImplementation((...args) => {
    if (String(args[0]) === ${JSON.stringify(pauseAt)}) {
      process.stdout.write("CANDIDATE_READ_STARTED\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return open(...args);
  });
  const run = async (argv) => {
    const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  await new Supervision({ stateDir: ${JSON.stringify(state.dir)}, run, clock: { now: () => ${start + 60_000} } })
    .sweep(${JSON.stringify(f.lane)}, "Working 22m");
});
`,
    );
    const child = Bun.spawn([process.execPath, "test", script], { stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();
    interrupted = child;
    try {
      let output = "";
      const reader = child.stdout.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) throw new Error(`observer exited before the read boundary: ${await stderr}`);
          output += new TextDecoder().decode(next.value);
          if (output.includes("CANDIDATE_READ_STARTED")) break;
        }
      } finally {
        reader.releaseLock();
      }
      const saved = JSON.parse(readFileSync(join(state.dir, "lanes", f.lane.key, "supervision.json"), "utf8"));
      expect(saved.coverage.deferred).toContain(discovered);
      expect(saved.coverage.pending[0]).toBe(pauseAt);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      interrupted = undefined;
      await stderr;
    }
    expect(Bun.spawnSync(["git", "-C", f.repo, "add", "--", discovered]).exitCode).toBe(0);
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        f.repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "commit the discovered path while the observer is stopped",
      ]).exitCode,
    ).toBe(0);
    for (let window = 0; window < 7; window++) await f.sweep();
    expect(new Set(f.refs().map((ref) => ref.ref))).toEqual(new Set([...f.paths, discovered]));
  } finally {
    state.done();
  }
});
