import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Lane, Registry, statusOf } from "../src/registry.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("the real close CLI refuses dirty and unpushed work, then closes after a local push", async () => {
  const state = withState();
  try {
    const cwd = join(state.dir, "repo");
    const remote = join(state.dir, "remote.git");
    const stateDir = join(state.dir, "state");
    const config = join(state.dir, "config.json");
    mkdirSync(cwd);
    const env = {
      HOME: state.dir,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: state.dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Close Test",
      GIT_AUTHOR_EMAIL: "close-test@example.invalid",
      GIT_COMMITTER_NAME: "Close Test",
      GIT_COMMITTER_EMAIL: "close-test@example.invalid",
      DORI_CONFIG: config,
      DORI_STATE_DIR: stateDir,
      DORI_TELEMETRY: "0",
    };
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    git("init", "--bare", remote);
    git("init");
    const proof = join(cwd, "proof.txt");
    writeFileSync(proof, "verified\n");
    git("add", "proof.txt");
    git("commit", "-m", "initial proof");
    git("remote", "add", "origin", remote);
    git("push", "origin", "HEAD");
    writeFileSync(config, JSON.stringify({ stateDir, defaultCwd: cwd }));
    const registry = new Registry(stateDir);
    const lane: Lane = {
      key: "close-cli",
      title: "close CLI",
      thread: "none",
      brief: proof,
      done: `file ${proof}`,
      cwd,
      openedAt: new Date().toISOString(),
    };
    await registry.write(lane);
    const before = readFileSync(registry.path(lane.key), "utf8");
    const invoke = () => {
      const child = Bun.spawnSync([process.execPath, cli, "close", lane.key], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
    };

    writeFileSync(proof, "verified, with unfinished edits\n");
    const dirty = invoke();
    expect(dirty.code, dirty.err).toBe(2);
    expect(dirty.out).toContain(`unpushed work in ${cwd}`);
    expect(readFileSync(registry.path(lane.key), "utf8")).toBe(before);
    expect(readFileSync(proof, "utf8")).toContain("unfinished edits");

    git("add", "proof.txt");
    git("commit", "-m", "finish the edit");
    const ahead = invoke();
    expect(ahead.code, ahead.err).toBe(2);
    expect(ahead.out).toContain(`unpushed work in ${cwd}`);
    expect(readFileSync(registry.path(lane.key), "utf8")).toBe(before);

    git("push", "origin", "HEAD");
    const closed = invoke();
    expect(closed.code, closed.err).toBe(0);
    expect(closed.out).toContain("CLOSED close-cli");
    expect(statusOf((await registry.read(lane.key))!)).toBe("closed");
  } finally {
    state.done();
  }
});
