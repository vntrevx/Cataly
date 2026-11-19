import { resolve } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { observeSystemd } from "./schedule-systemd.ts";
import { scheduleDestination, ScheduleError, type ScheduleDelivery } from "./schedule-types.ts";
import { scheduleView } from "./schedule-view.ts";

export const scheduleErrors = [ScheduleError] as const;
const schedule: Command = async ({ key, positionals, rest, need, opt, values, config, deps }) => {
  if (
    (key === "list" && positionals.length !== 1) ||
    (key === "adopt" && positionals.length > 2) ||
    (["pause", "resume", "remove"].includes(key ?? "") && positionals.length !== 2)
  )
    die(`schedule ${key} has unexpected positional arguments`);
  const store = new ScheduleStore(config.stateDir);
  const name = (): string => positionals[1] || die("schedule needs a name");
  if (key === "add") {
    const separator = rest.indexOf("--");
    if (separator < 0 || separator === rest.length - 1) die("schedule add needs -- followed by the command argv");
    const argv = rest.slice(separator + 1);
    if (positionals.length - argv.length !== 2) die("schedule add needs exactly one name before --");
    const deliver = opt("deliver") ?? "wake";
    scheduleDestination(deliver);
    const job = await store.add(
      {
        name: name(),
        cron: need("cron"),
        tz: need("tz"),
        deliver: deliver as ScheduleDelivery,
        cwd: resolve(typeof values["cwd"] === "string" ? values["cwd"] : process.cwd()),
        argv,
      },
      deps.clock.now(),
    );
    console.log(JSON.stringify(job, null, 2));
  } else if (key === "list") {
    const view = await scheduleView(store, deps.run, deps.clock.now());
    console.log(JSON.stringify(view, null, 2));
    if (view.adopted.some((entry) => "error" in entry)) process.exitCode = 1;
  } else if (key === "adopt") {
    const unit = need("systemd");
    const entry = { name: positionals[1] ?? unit, unit, system: values["system"] === true };
    const observed = await observeSystemd(entry, deps.run, deps.clock.now());
    await store.adopt(entry);
    console.log(JSON.stringify(observed, null, 2));
  } else if (key === "pause" || key === "resume") {
    await store.pause(name(), key === "pause", deps.clock.now(), values["ack-interrupted"] === true);
    console.log("SCHEDULE " + name() + " " + (key === "pause" ? "paused" : "resumed"));
  } else if (key === "remove") {
    await store.remove(name());
    console.log("SCHEDULE " + name() + " removed; retained logs and systemd units were not touched");
  } else die("schedule needs add, list, pause, resume, remove or adopt");
};

const scheduler: Command = async ({ values, loopMinutes, config }) => {
  const minutes = values["loop"] === undefined ? 1 / 60 : loopMinutes();
  if (minutes >= 1) throw new ScheduleError("scheduler --loop must be less than 1 minute to avoid skipped occurrences");
  const { Scheduler } = await import("./scheduler.ts");
  const instance = new Scheduler(new ScheduleStore(config.stateDir));
  const stop = new AbortController();
  const interrupt = (): void => {
    stop.abort();
    instance.stop();
  };
  await instance.open();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    for (;;) {
      await instance.tick();
      if (minutes === 0) {
        await instance.settle();
        break;
      }
      if (stop.signal.aborted) break;
      const now = instance.now();
      const delay = instance.store
        .read()
        .jobs.reduce((ms, job) => (job.paused ? ms : Math.min(ms, Math.max(0, job.nextAt - now))), minutes * 60_000);
      await new Promise<void>((resolveSleep) => {
        const finish = (): void => {
          clearTimeout(timer);
          stop.signal.removeEventListener("abort", finish);
          resolveSleep();
        };
        const timer = setTimeout(finish, delay);
        stop.signal.addEventListener("abort", finish, { once: true });
        if (stop.signal.aborted) finish();
      });
      if (stop.signal.aborted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await instance.close();
  }
};
export const scheduleCommands: Readonly<Record<string, Command>> = { schedule, scheduler };
