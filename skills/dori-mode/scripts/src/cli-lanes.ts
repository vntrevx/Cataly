/** dori launch, adopt, claim-done, object-done, close, pause, resume and tell. */
import { readFileSync } from "node:fs";
import { type Command, die } from "./cli-context.ts";
import { PolicyError } from "./lane-policy.ts";
import { autoTrackLinks } from "./cli-pr.ts";
import { claimDone, closeLane, objectDone } from "./done-flow.ts";
import { adoptLane, type LaunchInput, launchLane, prepareLaunch } from "./launch.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { tellLane } from "./tell.ts";
import { allowPolicyOnce } from "./lane-policy-actions.ts";
import { currentLanePolicy, policyBinding } from "./lane-policy-store.ts";

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

const close: Command = async ({ key, opt, lane, deps }) => {
  const target = await lane(key ?? die("close needs a lane key"));
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

const tell: Command = async ({ key, need, lane, deps }) => {
  const target = await lane(key ?? die("tell needs a lane key"));
  const r = await tellLane(deps, target, need("text"));
  console.log(r.line);
  process.exit(r.code);
};

export const laneCommands: Readonly<Record<string, Command>> = {
  launch,
  adopt,
  policy: async ({ positionals, strings, lane, deps }) => {
    let bound = Boolean(process.env["DORI_LANE_POLICY"]);
    const caller = process.env["PI_SESSION_FILE"];
    if (!bound && caller) {
      try {
        let header = false;
        // Approval must originate outside the protected transcript, not just another branch of it.
        for (const line of readFileSync(caller, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { type?: unknown; id?: unknown; customType?: unknown } | null;
          if (typeof entry !== "object" || entry === null) throw new Error("invalid session record");
          if (entry.type === "session" && typeof entry.id === "string" && entry.id) header = true;
          if (entry.type === "custom" && entry.customType === "omp-dori:lane-policy") {
            bound = true;
            break;
          }
        }
        if (!bound && !header) throw new Error("missing native session header");
      } catch (error) {
        throw new PolicyError(
          `cannot inspect caller session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (bound) return die("policy grants must be issued from the owner or lead session, not a policy-bound lane");
    const [action, key, rule, ...extra] = positionals;
    if (action !== "allow-once" || !key || !rule || extra.length)
      return die("usage: dori policy allow-once <key> <denyBash[index]> --reason <owner approval>");
    const [reason, ...otherReasons] = strings("reason");
    if (!reason?.trim() || otherReasons.length) return die("allow-once requires exactly one nonempty --reason");
    const target = await lane(key);
    const policy = currentLanePolicy(deps.config.stateDir, target.key);
    const grant = allowPolicyOnce(policyBinding(policy), rule, reason, deps.clock.now());
    console.log(
      `POLICY_ALLOW_ONCE ${target.key} rule=${grant.rule} command-sha256=${grant.hash}; retry explicitly; native approvals still apply`,
    );
  },
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
  pause: pauseOrResume,
  resume: pauseOrResume,
  tell,
};
