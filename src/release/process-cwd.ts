import { readFileSync, readlinkSync } from "node:fs";

/** A Linux process's start time in clock ticks since boot (`/proc/<pid>/stat` field 22), which a reused pid changes. */
export function processStart(pid: string): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is parenthesized and may hold spaces; fields after it are space-separated from 3 on.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Working directories by pid, and the live processes whose directory could not be read. */
export type ProcessCwds = { readonly cwds: Map<string, string>; readonly unreadable: readonly string[] };

/**
 * Working directories of running processes by pid: `/proc/<pid>/cwd` on Linux, `lsof` elsewhere (macOS has no /proc).
 * A process that exited is skipped; one that is alive but whose directory cannot be read (another user's, or one that
 * is not dumpable) is listed in `unreadable`, and so is, without /proc, any live pid lsof did not report. Null when no
 * directory could be read at all, so a caller can hold instead of treating every process as using nothing.
 */
export function processCwds(pids: readonly string[], platform = process.platform): ProcessCwds | null {
  const cwds = new Map<string, string>();
  const unreadable: string[] = [];
  if (platform === "linux") {
    for (const pid of pids) {
      try {
        cwds.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") unreadable.push(pid);
      }
    }
    return cwds.size > 0 ? { cwds, unreadable } : null;
  }
  let output: string;
  try {
    // -F output: a `p<pid>` line opens each process, its cwd follows as `n<path>`; other fields are skipped.
    const lsof = Bun.spawnSync(["lsof", "-n", "-a", "-d", "cwd", "-F", "pn"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    // A run cut short (timeout or signal) printed only part of the table.
    if (lsof.exitedDueToTimeout || lsof.signalCode) return null;
    output = lsof.stdout.toString();
  } catch {
    return null;
  }
  let pid = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
  }
  // A pid lsof left out is unread unless it has exited: signal 0 only asks whether it exists (EPERM: it does).
  for (const asked of pids) {
    if (cwds.has(asked)) continue;
    try {
      process.kill(Number(asked), 0);
      unreadable.push(asked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") unreadable.push(asked);
    }
  }
  return cwds.size > 0 ? { cwds, unreadable } : null;
}
