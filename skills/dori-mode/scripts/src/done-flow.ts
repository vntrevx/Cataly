import { existsSync } from "node:fs";

import { type DoriConfig, fill } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { pendingDiscordLane } from "./messenger/discord-lane-inbox.ts";
import { type Lane, type Registry, sessionOf, statusOf, withStatus } from "./registry.ts";
import { type ChosenRuntimes, type Clock, iso, type Runner } from "./run.ts";
import { closeSession } from "./sessions.ts";
import { notifyLane } from "./tell.ts";
import { checkDone, type SignalIo } from "./signals.ts";
import { Supervision } from "./supervision.ts";
import { Lessons, type LessonInput } from "./lessons.ts";

export type FlowDeps = {
  readonly run: Runner;
  readonly clock: Clock;
  readonly registry: Registry;
  readonly config: DoriConfig;
  readonly exists?: (path: string) => boolean;
  readonly signalIo?: SignalIo;
  /** The session runtimes; built from `run`, `clock` and `config.runtime` when absent. */
  readonly rts?: ChosenRuntimes;
  /** The environment the runtimes are chosen from and run with; process.env when absent. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

const signalIo = (deps: FlowDeps, lane: Lane): SignalIo => ({
  cwd: lane.cwd ?? deps.config.defaultCwd,
  ...deps.signalIo,
});

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

/** Another writer moved the lane on: nothing recorded. CLI exit 3 requires re-reading before deciding anew. */
export const movedOn = async (deps: FlowDeps, lane: Lane, what: string): Promise<string> => {
  const current = await deps.registry.read(lane.key);
  return `LANE_CHANGED ${lane.key} moved on while this ran (now ${current ? statusOf(current) : "not registered"}, was ${statusOf(lane)}); ${what} not recorded`;
};

/** onRecorded runs after persistence and before notification, so send failure cannot skip it; it must not throw. */
export const claimDone = async (
  deps: FlowDeps,
  lane: Lane,
  evidence: string,
  onRecorded?: () => void,
): Promise<string> => {
  const at = iso(deps.clock);
  const claimed = await deps.registry.transition(lane, (current) =>
    withStatus(current, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false } }),
  );
  if (!claimed) return movedOn(deps, lane, "done claim");
  onRecorded?.();
  const closesAt = new Date(deps.clock.now() + windowMs(deps)).toISOString().slice(11, 16);
  await notifyLane(
    deps,
    claimed,
    `[LEAD] done claim recorded for ${lane.key}: this lane closes automatically at ${closesAt}Z (${deps.config.closeAfterMin} minutes) unless the lead objects with reasons. Stay idle until then; the lead reconciles any held objection before sending further instructions.`,
  );
  return `LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${evidence}`;
};

export const objectDone = async (
  deps: FlowDeps,
  lane: Lane,
  reasons: readonly string[],
  locked = false,
): Promise<string> => {
  const at = iso(deps.clock);
  const objected = await deps.registry.transition(lane, (current) =>
    withStatus(current, "not-done", reasons.join("; "), at, { objection: { at, reasons } }),
  );
  if (!objected) return movedOn(deps, lane, "objection");
  await notifyLane(
    deps,
    objected,
    `[LEAD] not done: ${reasons.join("; ")}; keep working, claim again when fixed`,
    locked,
  );
  return `LANE_NOT_DONE ${lane.key} ${reasons.join("; ")}`;
};

export const discoverWorktrees = async (
  lane: Lane,
  run: Runner,
  extraRoots: readonly string[] = [],
): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (
        line.startsWith("branch ") &&
        path !== root &&
        (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))
      )
        found.add(path);
    }
  }
  return [...found];
};

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  // Discover only worktrees named for the lane. If none exist, check its working cwd instead.
  // Otherwise cwd is the human's checkout and must not block the lane.
  const owned = await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd]);
  const roots = owned.length ? owned : [lane.cwd ?? deps.config.defaultCwd];
  for (const wt of roots) {
    if (!exists(wt)) continue;
    // A fallback cwd that is not a git checkout has nothing to push; it must not be reported as unreadable
    // git state, which would hide the real objection underneath it. A worktree the lane owns is always
    // checked: if its git state cannot be read, that blocks the close (#42).
    if (!owned.length) {
      const inside = await deps.run(["git", "-C", wt, "rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 || inside.out.trim() !== "true") continue;
    }
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};
export const closeLane = async (
  deps: FlowDeps,
  lane: Lane,
  note: string,
  lesson?: Pick<LessonInput, "rule" | "evidence">,
  locked = false,
): Promise<{ readonly closed: boolean; readonly lines: string[] }> => {
  const exists = deps.exists ?? existsSync;
  const checks = await checkDone(lane.done, deps.run, signalIo(deps, lane));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  if (checks.some((c) => !c.ok))
    return { closed: false, lines: [...lines, `REFUSED ${lane.key}: a Done signal is not live`] };
  // The close is committed before anything irreversible, and only if nothing moved the lane on since it was read: an
  // objection or new claim written meanwhile keeps it open, and one written after this finds it closed.
  const at = iso(deps.clock);
  const commit = async () =>
    pendingDiscordLane(deps.config.stateDir, lane)
      ? ("discord-pending" as const)
      : deps.registry.transition(lane, (current) => withStatus(current, "closed", note, at, { closedAt: at }));
  // A tell is sent before the close or refused after it (`locked`: the watch holds the lock); a held lock refuses.
  const held = locked ? { ok: true as const, value: await commit() } : await withDeliveryLock(deps, lane.key, commit);
  if (!held.ok)
    return { closed: false, lines: [...lines, `HELD ${lane.key} a message to the lane is in flight (${held.holder})`] };
  if (held.value === "discord-pending")
    return { closed: false, lines: [...lines, `HELD ${lane.key}: Discord messages are still pending`] };
  if (!held.value) return { closed: false, lines: [...lines, await movedOn(deps, lane, "close")] };
  // Cost is recorded on a best-effort basis: a failing hook is printed and never keeps a verified lane open.
  try {
    const cost = await new Supervision({ ...deps, stateDir: deps.config.stateDir }, deps.config.supervision).close(
      lane,
    );
    if (cost) lines.push(`COST ${lane.key} tokens=${cost.tokens ?? "unknown"} costUsd=${cost.costUsd ?? "unknown"}`);
  } catch (error) {
    lines.push(`COST ${lane.key} not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const cleanup: string[] = [];
  const hook = deps.config.hooks.threadDone;
  if (hook && lane.thread !== "none") {
    const r = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
    cleanup.push(r.code === 0 ? "thread marked done" : `thread hook failed: ${r.err.slice(0, 160)}`);
  }
  const ref = sessionOf(lane);
  if (ref) cleanup.push(await closeSession(deps, ref));
  const root = lane.cwd ?? deps.config.defaultCwd;
  for (const wt of (await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd])).filter(exists)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const receipt = { checks, note, cleanup };
  await deps.registry.update(lane.key, (current) => current && { ...current, receipt });
  if (lesson) {
    try {
      const added = new Lessons(deps.config.stateDir).add({ ...lesson, lane: lane.key, cwd: root }, deps.clock.now());
      lines.push(`LESSON ${added.id}`);
    } catch (error) {
      // Lesson capture is optional; report failure without undoing a completed close.
      lines.push(`LESSON_WARNING ${lane.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { closed: true, lines: [...lines, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};
const settle = async (deps: FlowDeps, lane: Lane, evidence: string): Promise<string> => {
  const blocked = await unpushedWork(deps, lane);
  if (blocked.length) return objectDone(deps, lane, blocked);
  const failing = (await checkDone(lane.done, deps.run, signalIo(deps, lane)))
    .filter((c) => !c.ok)
    .map((c) => `${c.signal} -> ${c.detail}`);
  if (failing.length) return objectDone(deps, lane, failing);
  // Verify and close under the delivery lock (see closeLane); a lock held past its wait leaves the claim for next tick.
  const held = await withDeliveryLock(deps, lane.key, async () => {
    if (pendingDiscordLane(deps.config.stateDir, lane))
      return `LANE_HELD ${lane.key}: Discord messages are still pending`;
    // The checks above took pane, git and network round trips: an objection or new claim written meanwhile wins.
    const verified = await deps.registry.transition(lane, (current) =>
      withStatus(current, "verified-done", "Done signals read back live", iso(deps.clock)),
    );
    if (!verified) return movedOn(deps, lane, "verification");
    const result = await closeLane(deps, verified, `Done: ${evidence}`, undefined, true);
    if (!result.closed)
      return (
        result.lines.find((l) => l.startsWith("LANE_CHANGED")) ??
        objectDone(
          deps,
          verified,
          result.lines.filter((l) => l.startsWith("SIGNAL NOT")),
          true,
        )
      );
    return `LANE_CLOSED ${lane.key} ${result.lines.at(-1)?.split(" ").slice(2).join(" ") ?? ""}`;
  });
  return held.ok
    ? held.value
    : `LANE_HELD ${lane.key} a message to the lane is in flight (${held.holder}); retried next tick`;
};

export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const listed of await deps.registry.list()) {
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    let lane = listed;
    const claim = listed.claim;
    if (!claim.emitted) {
      const emitted = await deps.registry.transition(lane, (current) => ({
        ...current,
        claim: { ...claim, emitted: true },
      }));
      if (!emitted) continue;
      out.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`);
      lane = emitted;
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    try {
      out.push(await settle(deps, lane, claim.evidence));
    } catch (error) {
      out.push(
        `LANE_WATCH_ERROR ${lane.key} ${error instanceof Error ? error.message : String(error)}; inspect dori tell ${lane.key} --status and the original session; do not resend`,
      );
    }
  }
  return out;
};
