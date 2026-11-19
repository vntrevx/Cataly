import type { SessionRef } from "../../../../src/runtime/types.ts";
import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { SweepAct } from "./freshness.ts";
import { type Lane, sameLaneGeneration, sessionOf } from "./registry.ts";
import { type Progress, reportLine } from "./reports.ts";
import { runtimesOf } from "./run.ts";
import { readScreen, sendVerified } from "./sessions.ts";

export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = new RegExp(
    `\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|halted|done) \\| (?!<what)\\S`,
  );
  const template = (l: string) => /["'`]\[REPORT\]/.test(l) && /\$?\{[A-Za-z_][\w.]*\}/.test(l);
  const hits = screen
    .split("\n")
    .flatMap((l) => (grammar.test(l) && !template(l) ? [l.slice(l.indexOf("[REPORT]"))] : []));
  return hits.at(-1)?.replace(/["'\])\s,]+$/, "") ?? null;
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home)
    .join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

// A report is a line that starts with [REPORT], or the last quoted element of an argv row, the shape lanes are told
// to send it in: an argv array ending in "lead:p1", "[REPORT] key | kind | text". Instructions
// and prompts that quote the grammar mid-sentence are dropped before parsing, so an example is never posted as the
// lane's progress. A report whose whole text is one unfilled placeholder ($name, ${name}, {name}, %s, <what>) is a
// template, quoted or not (#29). The match is anchored to the [REPORT] key | kind | text structure, so
// 'deployed api | %s' stays a real report.
const placeholderOnly =
  /^\s*\[REPORT\][^|]*\|[^|]*\|\s*["'`]?(\$\{?[A-Za-z_]\w*\}?|\{[A-Za-z_][\w.]*\}|%[sdif]|<[^>]+>)["'`)\s]*$/;
// An argv row is the whole line (optionally inside one spawn call): [ then quoted strings separated by commas, then ]. Only its last element can be the
// report, which is how lanes are told to send it. Prose that happens to contain a quoted report is not an argv row.
const argvElements = (line: string): string[] | null => {
  // A spawn call around the row, such as Bun.spawn([...]) or subprocess.run([...]), is the same row.
  const call = /^\s*[\w.$]+\(\s*(\[.*\])\s*\)\s*;?\s*$/.exec(line);
  const row = (call?.[1] ?? line).trim();
  if (!row.startsWith("[") || !row.endsWith("]")) return null;
  const element = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*(,|$)/y;
  const inner = row.slice(1, -1);
  const elements: string[] = [];
  element.lastIndex = 0;
  while (element.lastIndex < inner.length) {
    const m = element.exec(inner);
    if (!m) return null;
    elements.push(m[1] ?? m[2] ?? "");
    if (m[3] === "") break;
  }
  return element.lastIndex === inner.length && elements.length > 0 ? elements : null;
};
const argvReport = (line: string): string | null => {
  const last = argvElements(line)?.at(-1);
  return last?.startsWith("[REPORT]") ? last : null;
};
const reportCandidate = (l: string): string | null => {
  if (!l.includes("[REPORT]")) return l;
  const report = /^\s*\[REPORT\]/.test(l) ? l : argvReport(l);
  return report !== null && !placeholderOnly.test(report) ? report : null;
};
export const anchoredReportLine = (screen: string, key: string): string | null =>
  lastReportLine(
    screen
      .split("\n")
      .flatMap((l) => reportCandidate(l) ?? [])
      .join("\n"),
    key,
  );

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

/** Update only the generation that produced this sweep, without overwriting other registry fields. */
export const rememberFreshness = (deps: FlowDeps, lane: Lane, patch: Partial<Lane>) =>
  deps.registry.transition(lane, (current) => ({ ...current, ...patch }));

const threadReplyHook = (deps: FlowDeps, lane: Lane, now: number, heard: number) => {
  // The post waits for the thread to be quiet, not the lane: a report resets only the nudge clock.
  const threadQuietMin = Math.round((now - Math.max(lastHeard(lane), lane.lastAutoReplyAt ?? 0)) / 60_000);
  // A report stamped in the same millisecond as the last post still counts; lastPostedReport stops a repeat.
  if (threadQuietMin >= deps.config.postAfterMin && lane.thread !== "none" && (lane.lastAutoReplyAt ?? 0) <= heard) {
    return deps.config.hooks.threadReply;
  }
  return undefined;
};

export const sampleLegacyReport = async (deps: FlowDeps, lane: Lane, ref: SessionRef, now: number) => {
  if (!threadReplyHook(deps, lane, now, lastHeard(lane))) return null;
  return anchoredReportLine(await readScreen(runtimesOf(deps), ref, 200), lane.key);
};

/** Called under the delivery lock, after the observed lane has been revalidated. */
export const notifyFreshness = async (
  deps: FlowDeps,
  lane: Lane,
  ref: SessionRef,
  progress: Progress | null,
  legacyReport: string | null,
  now: number,
  home: string,
  acts: SweepAct[],
): Promise<void> => {
  // A blocker, question, halted or done lane is not nudged, but its report still reaches the thread.
  const running = !progress || progress.state === "running";
  const heard = Math.max(lastHeard(lane), progress?.lastReport ? Date.parse(progress.lastReport.at) : 0);
  const silentMin = Math.round((now - heard) / 60_000);
  let current = lane;
  if (running && silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
    const delivery = await sendVerified(
      runtimesOf(deps),
      deps.clock,
      ref,
      `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`,
      undefined,
      lane.lifecycleEpoch ? lane.session : undefined,
    );
    // Record the completed attempt on its own pane even if a claim arrived during delivery.
    const nudged = await deps.registry.update(lane.key, (stored) => {
      if (!stored || stored.openedAt !== lane.openedAt || stored.lifecycleEpoch !== lane.lifecycleEpoch) return null;
      const actual = sessionOf(stored);
      if (actual?.id !== ref.id || actual.runtime !== ref.runtime || stored.session !== lane.session) return null;
      return { ...stored, lastNudgeAt: now };
    });
    if (!nudged) return;
    current = nudged;
    acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery ${delivery}` });
    if (!sameLaneGeneration(lane, current)) return;
  }
  const hook = threadReplyHook(deps, current, now, heard);
  if (hook) {
    // A journal report is durable, so it skips the two-tick hold; a screen-scraped line counts only once it is still
    // there on the next tick (the two reads are a full loop interval apart).
    const fromJournal = progress?.lastReport ? reportLine(progress.lastReport) : null;
    const report = fromJournal ?? legacyReport;
    const lastSeenReport = report ?? undefined;
    let hold: { kind: SweepAct["kind"]; detail: string } | null = null;
    if (!report)
      hold = {
        kind: "no-report",
        detail: lane.reportProtocol === "jsonl-v1" ? "report journal has no report" : "pane has no [REPORT] line",
      };
    else if (!fromJournal && report !== current.lastSeenReport)
      hold = { kind: "pending-report", detail: "a new [REPORT] line; posting once it holds on the next tick" };
    else if (report === current.lastPostedReport)
      hold = { kind: "stale-report", detail: "the last [REPORT] line was already posted" };
    if (hold) {
      const note = `${hold.kind}|${hold.detail}|${report ?? ""}`;
      const recorded = await rememberFreshness(deps, lane, { lastSeenReport, lastFreshnessNote: note });
      if (recorded && note !== current.lastFreshnessNote) {
        acts.push({ kind: hold.kind, lane: lane.key, detail: hold.detail });
      }
      return;
    }
    const text = `Progress (from the lane's last report): ${scrubForThread(report ?? "", home)}`;
    const latest = await deps.registry.read(lane.key);
    if (!latest || !sameLaneGeneration(lane, latest)) return;
    const sent = await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
    // Only a delivered report counts as posted: a failed hook leaves it unposted, so the next tick sends it again. Like
    // a held-back report, the same failure is printed once, not on every retry.
    if (sent.code !== 0) {
      const detail = `thread hook failed (exit ${sent.code})`;
      const note = `post-failed|${detail}|${report}`;
      const recorded = await rememberFreshness(deps, lane, { lastSeenReport, lastFreshnessNote: note });
      if (recorded && note !== current.lastFreshnessNote) acts.push({ kind: "post-failed", lane: lane.key, detail });
      return;
    }
    const posted = await rememberFreshness(deps, lane, {
      lastSeenReport,
      lastAutoReplyAt: now,
      lastPostedReport: report ?? undefined,
      lastFreshnessNote: undefined,
    });
    if (posted) acts.push({ kind: "posted", lane: lane.key, detail: text });
  }
};
