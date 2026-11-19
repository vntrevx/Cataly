import type { Runner } from "./run.ts";
import { scheduleOutput, ScheduleStore } from "./schedule-store.ts";
import { observeSystemd } from "./schedule-systemd.ts";

export async function scheduleView(store: ScheduleStore, run: Runner, now: number) {
  const document = store.read();
  const adopted = [];
  for (const entry of document.adopted) {
    try {
      adopted.push(await observeSystemd(entry, run, now));
    } catch (error) {
      adopted.push({ ...entry, observedAt: new Date(now).toISOString(), error: String(error), readOnly: true });
    }
  }
  return {
    jobs: document.jobs.map((job) => ({
      ...job,
      next: job.paused ? null : new Date(job.nextAt).toISOString(),
      ...(job.last
        ? { last: { ...job.last, output: scheduleOutput(store.stateDir, job.last.id), pidIsLive: "unverified" } }
        : {}),
    })),
    adopted,
  };
}
export async function scheduleBoot(
  stateDir: string,
  run: Runner,
  now: number,
): Promise<{ lines: string[]; failed: boolean }> {
  try {
    const view = await scheduleView(new ScheduleStore(stateDir), run, now);
    const lines = view.jobs.map(
      (job) =>
        "SCHEDULE " +
        job.name +
        " paused=" +
        job.paused +
        " next=" +
        (job.next ?? "paused") +
        " last=" +
        (job.last?.status ?? "never") +
        " delivery=" +
        (job.last?.delivery ?? "none") +
        " missed=" +
        job.missed,
    );
    for (const unit of view.adopted) lines.push("SCHEDULE_SYSTEMD " + JSON.stringify(unit));
    return { lines, failed: view.adopted.some((entry) => "error" in entry) };
  } catch (error) {
    return { lines: ["SCHEDULES unreadable: " + String(error)], failed: true };
  }
}
