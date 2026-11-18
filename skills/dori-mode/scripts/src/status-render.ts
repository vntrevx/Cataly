import { scrubForThread } from "./freshness.ts";
import type { StatusSnapshot } from "./status.ts";

const line = (text: string) => Bun.stripANSI(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");

export const renderStatus = (snapshot: StatusSnapshot): string => {
  const lines: string[] = [];
  let thread: string | undefined;
  for (const lane of snapshot.lanes) {
    if (lane.thread !== thread) {
      thread = lane.thread;
      lines.push(`THREAD ${line(thread)}`);
    }
    const state = lane.runtime;
    const elapsed = Math.max(
      0,
      Math.floor((Date.parse(lane.closedAt ?? snapshot.observedAt) - Date.parse(lane.openedAt)) / 60_000),
    );
    lines.push(
      `  ${lane.key} ${lane.status} ${Number.isFinite(elapsed) ? `${elapsed}m` : "elapsed unknown"} | agent=${state?.agentStatus ?? "unknown"} goal=${state?.goal.status ?? "unknown"} approval=${state ? state.approvalPending : "unknown"} decisions=${lane.decisions ?? "unknown"}`,
    );
    if (state) lines.push(`    runtime observed ${state.updatedAt}`);
    const progress = lane.progress;
    if (progress) {
      lines.push(`    progress=${progress.state} at=${progress.lastEvent.at}`);
      const report = progress.lastReport;
      if (report) lines.push(`    last ${report.at} ${report.kind}: ${line(report.text)}`);
    } else lines.push("    progress=unknown (no readable journal)");
    if (lane.checkpoint)
      lines.push(`    checkpoint ${lane.checkpoint.at} ${line(lane.checkpoint.step)}: ${line(lane.checkpoint.result)}`);
    lines.push(
      `    last sweep note=${line(lane.lastSweepNote ?? "unrecorded")} nudge=${lane.lastNudgeAt ?? "none"} post=${lane.lastPostedAt ?? "none"}`,
    );
    for (const error of lane.errors) lines.push(`    WARN ${error}`);
  }
  if (!snapshot.lanes.length) lines.push("LANES none open");
  lines.push(`DECISIONS ${snapshot.decisions ?? "unknown"} open`);
  const m = snapshot.monitors;
  lines.push(
    `MONITORS ${m.recorded ?? "unknown"} recorded, ${m.suspended ?? "unknown"} suspended, ${m.expired ?? "unknown"} expired (metadata only; liveness unverified)`,
  );
  for (const error of snapshot.errors) lines.push(`WARN ${error}`);
  return lines.join("\n");
};

/** Bounded plain text: one message, no paths/pane IDs from reports and no mention notifications. */
export const renderBoard = (snapshot: StatusSnapshot, home: string, limit: number): string => {
  const clean = (text: string) =>
    scrubForThread(
      line(text).replace(
        /https?:\/\/[^\s<>"']+|(?<![\p{L}\p{N}_./\\])(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s<>"'\x60()[\]{}]+/giu,
        (match) => (/^https?:/i.test(match) ? match : "(local path)"),
      ),
      home,
    )
      .replace(/@/g, "(at)")
      .replace(/\$\(/g, "$ (");
  const lines = [`Dori status | ${snapshot.lanes.length} lanes | ${snapshot.decisions ?? "unknown"} decisions open`];
  let shown = 0;
  for (const lane of snapshot.lanes) {
    const report = lane.progress?.lastReport;
    const summary = `${clean(lane.key)} | ${lane.status} | agent ${lane.runtime?.agentStatus ?? "unknown"} | ${lane.runtime?.approvalPending ? "approval pending" : (lane.progress?.state ?? "progress unknown")}`;
    const detail = report ? `\n  ${report.at} ${report.kind}: ${clean(report.text).slice(0, 240)}` : "";
    if ([...lines, summary + detail].join("\n").length > limit - 100) break;
    lines.push(summary + detail);
    shown++;
  }
  if (shown < snapshot.lanes.length) lines.push(`${snapshot.lanes.length - shown} more lanes: use dori status`);
  if (snapshot.errors.length || snapshot.lanes.some((l) => l.errors.length))
    lines.push("WARN incomplete observations: use dori status");
  return lines.join("\n");
};
