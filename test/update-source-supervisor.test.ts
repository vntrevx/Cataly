import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourceFixture } from "./update-source-setup.ts";

const supervisor = resolve(import.meta.dir, "../scripts/update-supervisor.ts");

async function supervise(
  codes: number[],
  options: { handoff?: boolean; wrongController?: boolean; mode?: string; unprotected?: boolean } = {},
) {
  const f = sourceFixture();
  const calls = join(f.root, "controller-calls.jsonl");
  writeFileSync(calls, "");
  const executable = join(f.root, "recorded-controller-bun");
  // The supervisor contract is exercised with a recorded controller exit, not a replacement product implementation.
  writeFileSync(
    executable,
    String.raw`#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
const calls = ${JSON.stringify(calls)};
const count = readFileSync(calls, "utf8").split("\n").filter(Boolean).length;
appendFileSync(calls, JSON.stringify({ args: process.argv.slice(2), env: {
  gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN, discord: process.env.DORI_DISCORD_TOKEN, sudo: process.env.SUDO_USER,
  telemetry: process.env.DORI_TELEMETRY, tracking: process.env.DO_NOT_TRACK,
} }) + "\n");
if (${options.handoff === true}) {
  const previous = ${JSON.stringify(join(f.root, "previous-controller"))};
  const next = ${JSON.stringify(join(f.root, "next-controller"))};
  mkdirSync(next); renameSync(${JSON.stringify(f.config.deployment.liveSource)}, previous);
  symlinkSync(next, ${JSON.stringify(f.config.deployment.liveSource)});
}
const codes = ${JSON.stringify(codes)};
if (count + 1 < codes.length) process.kill(process.ppid, "SIGUSR1");
process.exit(codes[count] ?? 2);
`,
    { mode: 0o700 },
  );
  if (options.unprotected) chmodSync(f.path, 0o666);
  const child = Bun.spawn(
    [
      process.execPath,
      supervisor,
      "--mode",
      options.mode ?? "source",
      "--config",
      f.path,
      "--controller",
      options.wrongController ? f.root : f.config.deployment.liveSource,
      "--bun",
      executable,
    ],
    {
      env: {
        HOME: f.config.deployment.home,
        PATH: process.env["PATH"],
        GH_TOKEN: "fixture-gh",
        GITHUB_TOKEN: "fixture-github",
        DORI_DISCORD_TOKEN: "fixture-discord",
        SUDO_USER: "fixture-sudo",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const invocations = readFileSync(calls, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
    return { ...f, code, stdout, stderr, invocations };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

test("source supervisor runs only idle source apply and resumes durable recovery on a wakeup", async () => {
  const f = await supervise([6, 2]);
  expect(f.code).toBe(2);
  expect(f.stdout).toContain("DORI_SUPERVISOR_READY");
  expect(f.stderr).toContain("source=recovery-pending");
  expect(f.invocations).toHaveLength(2);
  for (const invocation of f.invocations) {
    expect(invocation.args).toEqual([
      join(f.config.deployment.liveSource, "skills/dori-mode/scripts/src/cli.ts"),
      "update",
      "source",
      "apply",
      "--when",
      "idle",
      "--config",
      f.path,
    ]);
    expect(invocation.env).toEqual({ telemetry: "0", tracking: "1" });
    expect(invocation.args).not.toContain("--retry-failed");
  }
  expect(existsSync(f.config.deployment.releaseRoot)).toBe(false);
});

test("source supervisor asks its service manager to reload after the live-source pointer changes", async () => {
  const f = await supervise([0], { handoff: true });
  expect(f.code).toBe(75);
  expect(f.invocations).toHaveLength(1);
  expect(readFileSync(join(f.root, "previous-controller/owner.ts"), "utf8")).toContain("original");
});

for (const options of [{ wrongController: true }, { mode: "unknown" }, { unprotected: true }])
  test(`source supervisor rejects an invalid opt-in before any controller launch ${JSON.stringify(options)}`, async () => {
    const f = await supervise([0], options);
    expect(f.code).toBe(2);
    expect(f.invocations).toHaveLength(0);
    expect(f.stdout).not.toContain("DORI_SUPERVISOR_READY");
  });
