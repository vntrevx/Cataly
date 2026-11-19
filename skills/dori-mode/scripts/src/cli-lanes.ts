/** dori launch, adopt, claim-done, object-done, close, pause, resume and tell. */
import { type Command, die } from "./cli-context.ts";
import { autoTrackLinks } from "./cli-pr.ts";
import { claimDone, closeLane, objectDone } from "./done-flow.ts";
import { adoptLane, type LaunchInput, launchLane, prepareLaunch } from "./launch.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { DeliveryState } from "./delivery-state.ts";
import { parkLane } from "./park.ts";
import { reopenLane } from "./reopen.ts";
import { holdLines } from "./holds.ts";
import { resolveTell, tellLane } from "./tell.ts";

const launch: Command = async ({ key, opt, need, ceiling, strings, values, deps }) => {
  const wallMinutes = ceiling("wall-minutes"),
    tokens = ceiling("token-limit"),
    costUsd = ceiling("cost-limit");
  const thread = opt("thread"),
    model = opt("model"),
    cwd = opt("cwd");
  const input: LaunchInput = {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    budget: {
      ...(wallMinutes !== undefined ? { wallMinutes } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    activityPaths: strings("activity-path"),
  };
  if (values["dry-run"]) {
    const prepared = await prepareLaunch(deps, input);
    for (const warning of prepared.warnings) console.error(warning);
    console.log(prepared.preamble);
    return;
  }
  const r = await launchLane(deps, input);
  for (const warning of r.warnings) console.error(warning);
  console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
  console.log(r.startup);
  process.exit(r.startup.startsWith("STARTUP_OK") || r.startup.startsWith("STARTUP_DONE") ? 0 : 3);
};

const adopt: Command = async ({ key, opt, need, deps }) => {
  const thread = opt("thread");
  const l = await adoptLane(deps, {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    pane: need("pane"),
  });
  console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
};

const close: Command = async ({ key, opt, strings, values, lane, deps }) => {
  const target = await lane(key ?? die("close needs a lane key"));
  if (values["abandon"]) {
    const reason = strings("reason")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("; ");
    if (!reason) die("close --abandon requires --reason");
    if (opt("lesson")) die("--lesson is only for a verified completion");
    const r = await parkLane(deps, target, reason, "abandoned");
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  }
  const rule = opt("lesson");
  const r = await closeLane(
    deps,
    target,
    opt("note") ?? "closed by the lead",
    rule === undefined ? undefined : { rule, evidence: opt("evidence") ?? target.done },
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.closed ? 0 : r.lines.at(-1)?.startsWith("LANE_CHANGED") ? 3 : 2);
};

/** Prints a done-flow result; `LANE_CHANGED` (another writer moved the lane on, nothing recorded) exits 3. */
const recorded = (line: string): void => {
  console.log(line);
  if (line.startsWith("LANE_CHANGED")) process.exit(3);
};

const pauseOrResume: Command = async ({ command, key, opt, lane, deps }) => {
  const act = command === "pause" ? pauseLane : resumeLane;
  const r = await act(
    deps,
    await lane(key ?? die(`${command} needs a lane key`)),
    opt("note") ?? `${command}d by the lead`,
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.code);
};

const tell: Command = async ({ key, need, values, lane, deps }) => {
  const target = key ?? die("tell needs a lane key");
  if ([values["text"], values["status"], values["resolve"]].filter((value) => value !== undefined).length !== 1)
    die("choose exactly one: --text TEXT, --status, or --resolve REQUEST_ID --note REASON");
  if (values["status"] === true) {
    console.log(`TELL_STATE ${target} ${JSON.stringify(new DeliveryState(deps.registry, target).read())}`);
    return;
  }
  const r =
    values["resolve"] !== undefined
      ? await resolveTell(deps, target, need("resolve"), need("note"))
      : await tellLane(deps, await lane(target), need("text"));
  console.log(r.line);
  process.exit(r.code);
};

export const laneCommands: Readonly<Record<string, Command>> = {
  launch,
  adopt,
  "claim-done": async (cli) => {
    const target = await cli.lane(cli.key);
    const evidence = cli.need("evidence");
    recorded(
      await claimDone(cli.deps, target, evidence, () =>
        autoTrackLinks(cli, target, evidence, `claim-done ${target.key}`),
      ),
    );
  },
  "object-done": async ({ key, values, lane, deps }) => {
    const reasons = (values["reason"] as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (!reasons.length) die("--reason is required");
    recorded(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
  },
  close,
  park: async ({ key, need, opt, lane, deps }) => {
    const r = await parkLane(
      deps,
      await lane(key ?? die("park needs a lane key")),
      need("note"),
      "parked",
      opt("resume-when"),
    );
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  },
  reopen: async ({ key, opt, deps }) => {
    const target = await deps.registry.read(key ?? die("reopen needs a lane key"));
    if (!target) return die(`no registered lane "${key}"`);
    const r = await reopenLane(deps, target, opt("note"));
    for (const line of r.lines) console.log(line);
    process.exit(r.code);
  },
  holds: async ({ opt, deps }) => {
    for (const line of holdLines(await deps.registry.list(), opt("thread"))) console.log(line);
  },
  pause: pauseOrResume,
  resume: pauseOrResume,
  tell,
};
