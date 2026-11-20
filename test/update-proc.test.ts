import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity, sameProcess, underProcess } from "../src/update/deployment-process.ts";
import {
  bootId,
  procChildren,
  procCmdline,
  procCwd,
  procEnviron,
  procExeTarget,
  procStat,
} from "../src/update/proc.ts";

const darwin = test.skipIf(process.platform !== "darwin");
const children: Bun.Subprocess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ps = (pid: number, field: string): string =>
  Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)])
    .stdout.toString()
    .trim();

// A shell that keeps one sleeping child, started in its own folder with arguments that hold spaces.
async function shellWithChild() {
  const cwd = mkdtempSync(join(tmpdir(), "omp-proc-"));
  dirs.push(cwd);
  const shell = Bun.spawn(["/bin/sh", "-c", "sleep 60 & echo ready; wait", "arg one", "arg two"], {
    cwd,
    stdout: "pipe",
  });
  children.push(shell);
  const reader = shell.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  return { shell, cwd };
}

darwin("macOS reads the same status, arguments, folder, children and image as ps and lsof", async () => {
  // Given a live shell with one child.
  const { shell, cwd } = await shellWithChild();
  // When its facts are read.
  const stat = procStat(shell.pid);
  // Then each one matches the system's own tools.
  expect(stat.zombie).toBe(false);
  expect(stat.ppid).toBe(process.pid);
  expect(stat.pgid).toBe(Number(ps(shell.pid, "pgid")));
  expect(stat.startTicks).toMatch(/^\d+$/);
  expect(procCmdline(shell.pid)).toBe("/bin/sh\0-c\0sleep 60 & echo ready; wait\0arg one\0arg two\0");
  expect(realpathSync(procCwd(shell.pid))).toBe(realpathSync(cwd));
  const kids = procChildren(shell.pid);
  expect(kids).toHaveLength(1);
  expect(ps(kids[0]!, "comm")).toBe("sleep");
  expect(procExeTarget(shell.pid)).toBe(
    Bun.spawnSync(["lsof", "-a", "-p", String(shell.pid), "-d", "txt", "-Fn"])
      .stdout.toString()
      .split("\n")
      .find((line) => line.startsWith("n/"))!
      .slice(1),
  );
  expect(bootId()).toMatch(/^[0-9A-F-]{36}$/);
});

darwin(
  "an identity binds one incarnation: a live process matches, a child is under it, and a dead one never does",
  async () => {
    // Given a live shell with one child.
    const { shell } = await shellWithChild();
    const identity = processIdentity(shell.pid);
    const child = procChildren(shell.pid)[0]!;
    // Then the identity holds and ancestry is read from parent links.
    expect(identity).toBeDefined();
    expect(sameProcess(identity!)).toBe(true);
    expect(underProcess(child, shell.pid)).toBe(true);
    expect(underProcess(shell.pid, child)).toBe(false);
    // When the shell exits, then its identity no longer matches and it has no readable status.
    shell.kill("SIGKILL");
    await shell.exited;
    expect(sameProcess(identity!)).toBe(false);
    expect(processIdentity(shell.pid)).toBeUndefined();
    expect(() => procCmdline(shell.pid)).toThrow();
  },
);

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "a process's own environment is read apart from its arguments",
  async () => {
    // Given a Bun child (macOS hides platform binaries' environments) with its own HOME and an argument like an entry.
    const child = Bun.spawn([process.execPath, "-e", 'console.log("up"); await Bun.stdin.text()', "HOME=/arg"], {
      env: { HOME: "/tmp/proc-env-home", PATH: process.env["PATH"] },
      stdin: "pipe",
      stdout: "pipe",
    });
    children.push(child);
    await child.stdout.getReader().read();
    // Then the environment holds its HOME, and the argument stays in the arguments.
    const entries = procEnviron(child.pid).split("\0");
    expect(entries).toContain("HOME=/tmp/proc-env-home");
    expect(entries).not.toContain("HOME=/arg");
    expect(procCmdline(child.pid).split("\0")).toContain("HOME=/arg");
  },
);
