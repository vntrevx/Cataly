import type { Runner } from "./run.ts";
import { type AdoptedSchedule, ScheduleError, systemdUnit } from "./schedule-types.ts";

const PROPERTIES =
  "LoadState,ActiveState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic,NextElapseUSecRealtime,NextElapseUSecMonotonic,LastTriggerUSec,Unit";
export async function observeSystemd(entry: AdoptedSchedule, run: Runner, now: number) {
  systemdUnit(entry.unit);
  const show = async (unit: string): Promise<Record<string, string>> => {
    const result = await run(
      [
        "env",
        "LC_ALL=C",
        "TZ=UTC",
        "systemctl",
        ...(entry.system ? ["--system"] : ["--user"]),
        "show",
        "--no-pager",
        "--property=" + PROPERTIES,
        "--",
        unit,
      ],
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0)
      throw new ScheduleError("systemd observation failed for " + unit + ": " + result.err.slice(0, 400));
    const properties: Record<string, string> = {};
    for (const line of result.out.split("\n")) {
      const at = line.indexOf("=");
      if (at >= 0) properties[line.slice(0, at)] = line.slice(at + 1);
    }
    if (!properties["LoadState"] || properties["LoadState"] === "not-found")
      throw new ScheduleError("systemd unit not found: " + unit);
    return properties;
  };
  const unit = await show(entry.unit);
  const serviceName = entry.unit.endsWith(".service") ? entry.unit : unit["Unit"];
  if (serviceName) systemdUnit(serviceName);
  const service = serviceName === entry.unit ? unit : serviceName ? await show(serviceName) : undefined;
  const present = (value: string | undefined): string | null =>
    value && value !== "n/a" && value !== "0" ? value : null;
  const started = present(service?.["ExecMainStartTimestamp"]);
  const finished = present(service?.["ExecMainExitTimestamp"]);
  const startedMicros = service?.["ExecMainStartTimestampMonotonic"];
  const finishedMicros = service?.["ExecMainExitTimestampMonotonic"];
  const status = service?.["ExecMainStatus"];
  return {
    ...entry,
    observedAt: new Date(now).toISOString(),
    activeState: unit["ActiveState"] ?? null,
    next: present(unit["NextElapseUSecRealtime"]),
    nextMonotonic: present(unit["NextElapseUSecMonotonic"]),
    lastTrigger: present(unit["LastTriggerUSec"]),
    lastExit:
      started &&
      finished &&
      startedMicros &&
      finishedMicros &&
      /^[1-9]\d*$/.test(startedMicros) &&
      /^[1-9]\d*$/.test(finishedMicros) &&
      BigInt(finishedMicros) >= BigInt(startedMicros) &&
      status &&
      /^\d+$/.test(status)
        ? { startedAt: started, finishedAt: finished, code: Number(status), result: service?.["Result"] ?? null }
        : null,
    missed: "systemd-managed",
    readOnly: true,
  };
}
