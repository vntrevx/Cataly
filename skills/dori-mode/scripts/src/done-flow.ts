import { existsSync } from "node:fs";
import { type DoriConfig, fill } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { Lessons } from "./lessons.ts";
import { pendingDiscordLane } from "./messenger/discord-lane-inbox.ts";
import { type CloseLesson, commitClose, recordDoneDecision } from "./native-close.ts";
import { type Lane, type Registry, sameLaneGeneration, sessionOf, statusOf, withStatus } from "./registry.ts";
import { type ChosenRuntimes, type Clock, iso, type Runner } from "./run.ts";
import { closeSession } from "./sessions.ts";
import { notifyLane } from "./tell.ts";
import { checkDone, type SignalIo } from "./signals.ts";
import { Supervision } from "./supervision.ts";

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

const windowMs = (deps: FlowDeps): number => deps.config.closeAfterMin * 60_000;

/** A newer lane state invalidated the requested transition, not necessarily earlier external effects. */
export const movedOn = async (deps: FlowDeps, lane: Lane, what: string): Promise<string> => {
  const current = await deps.registry.read(lane.key);
  return `LANE_CHANGED ${lane.key} moved on while this ran (now ${current ? statusOf(current) : "not registered"}, was ${statusOf(lane)}); ${what} not recorded`;
};

/** `onRecorded` runs before notifying the lane and must not throw. */
export const claimDone = async (
  deps: FlowDeps,
  lane: Lane,
  evidence: string,
  onRecorded?: () => void,
): Promise<string> => {
  const at = iso(deps.clock);
  const claimed = await recordDoneDecision(deps, lane, (current) =>
    withStatus(current, "done-claimed", evidence, at, { claim: { at, evidence, emitted: false } }),
  );
  if (claimed === "closing") return `LANE_CHANGED ${lane.key} native close is in progress; done claim not recorded`;
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
  const objected = await recordDoneDecision(deps, lane, (current) =>
    withStatus(current, "not-done", reasons.join("; "), at, { objection: { at, reasons } }),
  );
  if (objected === "closing") return `LANE_CHANGED ${lane.key} native close is in progress; objection not recorded`;
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
  // Check owned worktrees instead of blocking on changes in the human's checkout.
  // If the lane works directly in its cwd, that checkout must be checked instead.
  const owned = await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd]);
  const roots = owned.length ? owned : [lane.cwd ?? deps.config.defaultCwd];
  for (const wt of roots) {
    if (!exists(wt)) continue;
    // Only the fallback cwd may be skipped when it is not a checkout (#42).
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
type CloseResult = { readonly closed: boolean; readonly lines: string[] };
const closeHeld = async (
  deps: FlowDeps,
  seen: Lane,
  requestedNote: string,
  requestedLesson?: CloseLesson,
  settlingClaim = false,
): Promise<CloseResult> => {
  const lane = await deps.registry.read(seen.key);
  if (!lane || !sameLaneGeneration(seen, lane))
    return { closed: false, lines: [await movedOn(deps, seen, settlingClaim ? "verification" : "close")] };
  const saved = lane.nativeCloseIntent;
  const checks =
    saved?.checks ??
    (await checkDone(lane.done, deps.run, { cwd: lane.cwd ?? deps.config.defaultCwd, ...deps.signalIo }));
  const lines = checks.map((c) => `SIGNAL ${c.ok ? "OK " : "NOT"} ${c.signal} -> ${c.detail}`);
  const fail = (text: string): CloseResult => ({ closed: false, lines: [...lines, text] });
  if (checks.some((c) => !c.ok)) return fail(`REFUSED ${lane.key}: a Done signal is not live`);
  const ref = sessionOf(lane);
  if (!saved && pendingDiscordLane(deps.config.stateDir, lane))
    return fail(`HELD ${lane.key}: Discord messages are still pending`);
  const basis = saved ?? {
    note: requestedNote,
    checks,
    settlingClaim,
    ...(requestedLesson && { lesson: requestedLesson }),
  };
  const result = await commitClose(deps, lane, basis);
  if (result.kind === "held") return fail(`HELD ${lane.key}: ${result.reason}`);
  const cleanup = result.pane ? [`pane ${result.pane} closed`] : [];
  if (result.kind === "changed")
    return fail(`${await movedOn(deps, lane, "close")}${cleanup[0] ? `; ${cleanup[0]}` : ""}`);
  const { lane: closed } = result;
  const { note, lesson } = basis;
  // Cost is recorded on a best-effort basis: a failing hook is printed and never keeps a verified lane open.
  const supervisor = new Supervision({ ...deps, stateDir: deps.config.stateDir }, deps.config.supervision);
  try {
    const cost = await supervisor.close(lane);
    if (cost) lines.push(`COST ${lane.key} tokens=${cost.tokens ?? "unknown"} costUsd=${cost.costUsd ?? "unknown"}`);
  } catch (error) {
    lines.push(`COST ${lane.key} not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.pane) {
    const now = await deps.registry.read(lane.key);
    if (!now || !sameLaneGeneration(closed, now)) return fail(await movedOn(deps, closed, "cleanup (pane closed)"));
  }
  const hook = deps.config.hooks.threadDone;
  if (hook && lane.thread !== "none") {
    const r = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
    cleanup.push(r.code === 0 ? "thread marked done" : `thread hook failed: ${r.err.slice(0, 160)}`);
  }
  if (ref && !result.pane) cleanup.push(await closeSession(deps, ref));
  const root = lane.cwd ?? deps.config.defaultCwd;
  const worktrees = await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd]);
  for (const wt of worktrees.filter(deps.exists ?? existsSync)) {
    const r = await deps.run(["git", "-C", root, "worktree", "remove", wt]);
    cleanup.push(r.code === 0 ? `worktree ${wt} removed` : `worktree ${wt} kept: ${r.err.slice(0, 120)}`);
  }
  const receipt = { outcome: "done", checks, note, cleanup };
  if (!(await deps.registry.transition(closed, (current) => ({ ...current, receipt }))))
    return { closed: false, lines: [...lines, await movedOn(deps, closed, "close receipt (cleanup finished)")] };
  if (lesson) {
    try {
      const added = new Lessons(deps.config.stateDir).add({ ...lesson, lane: lane.key, cwd: root }, deps.clock.now());
      lines.push(`LESSON ${added.id}`);
    } catch (error) {
      lines.push(`LESSON_WARNING ${lane.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { closed: true, lines: [...lines, `CLOSED ${lane.key} ${JSON.stringify(receipt)}`] };
};

export const closeLane = async (
  deps: FlowDeps,
  lane: Lane,
  note: string,
  lesson?: CloseLesson,
): Promise<CloseResult> => {
  const held = await withDeliveryLock(deps, lane.key, () => closeHeld(deps, lane, note, lesson));
  return held.ok
    ? held.value
    : { closed: false, lines: [`HELD ${lane.key} a message to the lane is in flight (${held.holder})`] };
};
const settle = async (deps: FlowDeps, lane: Lane, note: string): Promise<string> => {
  try {
    if (!lane.nativeCloseIntent) {
      const blocked = await unpushedWork(deps, lane);
      if (blocked.length) return await objectDone(deps, lane, blocked);
    }
    const held = await withDeliveryLock(deps, lane.key, async () => {
      const result = await closeHeld(deps, lane, note, undefined, true);
      if (result.closed) return `LANE_${result.lines.at(-1)}`;
      const line = result.lines.at(-1) ?? "";
      if (line.startsWith("HELD ")) return `LANE_${line}`;
      const prefix = "SIGNAL NOT ";
      const failures = result.lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
      return failures.length ? objectDone(deps, lane, failures, true) : line;
    });
    return held.ok
      ? held.value
      : `LANE_HELD ${lane.key} a message to the lane is in flight (${held.holder}); retried next tick`;
  } catch (error) {
    return `LANE_WATCH_ERROR ${lane.key} ${error instanceof Error ? error.message : String(error)}; inspect the lane lifecycle, dori tell ${lane.key} --status and the original session; do not resend`;
  }
};
export const watchTick = async (deps: FlowDeps): Promise<string[]> => {
  const out: string[] = [];
  for (const listed of await deps.registry.list()) {
    if (listed.nativeCloseIntent) {
      out.push(await settle(deps, listed, listed.nativeCloseIntent.note));
      continue;
    }
    if (statusOf(listed) !== "done-claimed" || !listed.claim) continue;
    let lane = listed;
    const claim = listed.claim;
    if (!claim.emitted) {
      const emitted = await deps.registry.transition(lane, (current) =>
        current.nativeCloseIntent ? null : { ...current, claim: { ...claim, emitted: true } },
      );
      if (!emitted) continue;
      out.push(`LANE_DONE_CLAIMED ${lane.key} ${lane.pane ?? "-"} ${claim.evidence}`);
      lane = emitted;
    }
    if (deps.clock.now() - Date.parse(claim.at) < windowMs(deps)) continue;
    out.push(await settle(deps, lane, `Done: ${claim.evidence}`));
  }
  return out;
};
