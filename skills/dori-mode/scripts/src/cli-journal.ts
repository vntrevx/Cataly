/** dori report, lesson, worklog, checkpoint and checkpoints: the durable journals. */
import { CheckpointError, Checkpoints } from "./checkpoints.ts";
import { type Cli, type Command, die } from "./cli-context.ts";
import { autoTrackLinks } from "./cli-pr.ts";
import { isLessonOutcome, LessonError, Lessons } from "./lessons.ts";
import { isReportKind, ReportError } from "./report-events.ts";
import { Reports, reportLine, reportId, reportScope } from "./reports.ts";
import { runContext } from "./lane-run.ts";
import type { ReportProvenance } from "./request-identity.ts";
import { reportDelivery } from "./report-delivery.ts";
import { realClock, runtimesOf } from "./run.ts";
import { Worklog, WorklogError } from "./worklog.ts";

/** Journal errors are the user's input refused: one line, never a stack. */
export const journalErrors = [CheckpointError, LessonError, ReportError, WorklogError] as const;

const report: Command = async ({ key, need, opt, values, lane, config, deps }) => {
  const target = await lane(key ?? die("report needs a lane key"));
  const kind = need("kind");
  if (isReportKind(kind)) {
    const text = need("text");
    const owner = opt("owner");
    const reports = new Reports(config.stateDir);
    const entry = await deps.registry.withCurrent(target.key, (current) => {
      if (!current) throw new ReportError(`no registered lane "${target.key}"`);
      const context = runContext(reports, current, process.env["DORI_LANE_RUN"]);
      if (!context)
        throw new ReportError("report: unknown or missing run (DORI_LANE_RUN); no matching execution recorded");
      return reports.report(target.key, kind, text, realClock.now(), context.generation, owner, context.provenance);
    });
    const receipt = {
      ...entry,
      id: reportId(entry),
      ...(entry.provenance ? { delivery: reportDelivery(config.stateDir, entry) } : {}),
    };
    console.log(values["json"] ? JSON.stringify(receipt) : reportLine(entry));
  } else die("--kind must be milestone, blocker, question, halted or done");
};

const relayed: Command = async ({ key, need, values, lane, deps, config }) => {
  const target = await lane(key ?? die("relayed needs a lane key"));
  if (target.reportProtocol !== "jsonl-v1")
    die("relayed requires a launched jsonl-v1 lane, not an adopted screen report");
  const id = need("report");
  const deliveryId = values["delivery"] === undefined ? undefined : need("delivery");
  if (deliveryId !== undefined && !deliveryId.startsWith("discord:"))
    die("--delivery requires an exact Discord receipt ID");
  const reports = new Reports(config.stateDir);
  const updated = await deps.registry.transition(target, (current) => {
    const entry = reports.read(target.key, reportScope(current))?.lastReport;
    if (current.reportProtocol !== "jsonl-v1" || !entry || reportId(entry) !== id) return null;
    return {
      ...current,
      lastPostedReport: reportLine(entry),
      lastPostedReportId: id,
      lastPostedReportOwner: entry.owner,
      ...(entry.provenance || deliveryId !== undefined
        ? { lastPostedReportDelivery: reportDelivery(config.stateDir, entry, deliveryId) }
        : {}),
      lastRelayedAt: realClock.now(),
    };
  });
  if (!updated) return die("relayed: report is not the current journal report; read it again before acknowledging");
  const delivery = updated.lastPostedReportDelivery;
  console.log(
    delivery
      ? values["json"]
        ? JSON.stringify({ key: target.key, reportId: id, delivery })
        : `RELAYED ${target.key} ${id} delivery=${delivery.state}`
      : `RELAYED ${target.key} ${id}`,
  );
};

const lessonAdd = async (
  { positionals, values, opt, need, deps, config }: Cli,
  lessons: Lessons,
  paneLane: () => Promise<{ readonly key: string } | null>,
) => {
  const laneKey = positionals[1];
  if (values["global"]) {
    // A global lesson reaches every future brief, so it is the lead's: it takes no lane key and is recorded
    // as the lead's. paneLane() refuses it from a registered lane's pane.
    if (laneKey !== undefined) die("a --global lesson is the lead's: give no lane key");
    if (opt("cwd") !== undefined) die("a --global lesson has no --cwd");
    const caller = await paneLane();
    if (caller) die(`a --global lesson is the lead's; this pane is lane ${caller.key}`);
    console.log(
      JSON.stringify(
        lessons.add({ lane: "lead", scope: "global", rule: need("rule"), evidence: need("evidence") }, realClock.now()),
      ),
    );
    return;
  }
  const target =
    laneKey === undefined ? undefined : ((await deps.registry.read(laneKey)) ?? die(`no registered lane "${laneKey}"`));
  const repoLane = target ?? die("lesson add needs a lane key, or --global");
  console.log(
    JSON.stringify(
      lessons.add(
        {
          lane: repoLane.key,
          cwd: opt("cwd") ?? repoLane.cwd ?? config.defaultCwd,
          rule: need("rule"),
          evidence: need("evidence"),
        },
        realClock.now(),
      ),
    ),
  );
};

const lesson: Command = async (cli) => {
  const { key, positionals, opt, need, deps, config } = cli;
  const lessons = new Lessons(config.stateDir);
  // The open lane that owns the caller's own session (HC_TERMINAL_ID, else HERDR_PANE_ID, else TERN_PANE). A
  // convenience check: it stops a lane from adding or reviving a global lesson by accident or on routine instruction.
  // It is not a security boundary, since it reads only those session variables (unsetting them gets past it) and a
  // direct write to lessons.jsonl skips the CLI.
  const paneLane = async () => {
    return await deps.registry.bySession(runtimesOf(deps).selfAny(process.env));
  };
  switch (key) {
    case "add":
      return await lessonAdd(cli, lessons, paneLane);
    case "list": {
      const read = lessons.read(opt("cwd"));
      for (const problem of read.problems) console.error(`LESSON_WARNING ${problem}`);
      console.log(JSON.stringify(read.lessons, null, 2));
      return;
    }
    case "mark": {
      const id = positionals[1] ?? die("lesson mark needs a lesson id");
      // Marking a global lesson helped or pending puts it back into every brief, so a lane cannot mark one.
      // Repo lessons stay markable from lanes.
      if (lessons.read().lessons.find((lesson) => lesson.id === id)?.scope === "global") {
        const caller = await paneLane();
        if (caller) die(`a global lesson is the lead's to mark; this pane is lane ${caller.key}`);
      }
      const outcome = need("outcome");
      if (isLessonOutcome(outcome)) console.log(JSON.stringify(lessons.mark(id, outcome)));
      else die("--outcome must be pending, helped, no-effect, harmful or encoded");
      return;
    }
    default:
      die("lesson needs add, list or mark");
  }
};

const worklog: Command = async ({ key, positionals, values, need, config }) => {
  const worklog = new Worklog(config.stateDir);
  const id = () => positionals[1] ?? die(`worklog ${key} needs an item id`);
  const text = () => positionals.slice(2).join(" ").trim() || die(`worklog ${key} needs text`);
  const now = realClock.now();
  switch (key) {
    case "add":
      console.log(
        JSON.stringify(
          worklog.add(
            positionals.slice(1).join(" ").trim() || die("worklog add needs a title"),
            need("source"),
            now,
            values["thread"] === undefined ? undefined : need("thread"),
          ),
        ),
      );
      break;
    case "next":
      console.log(JSON.stringify(worklog.next(id(), text(), now)));
      break;
    case "note":
      console.log(JSON.stringify(worklog.note(id(), text(), now)));
      break;
    case "close":
      console.log(JSON.stringify(worklog.close(id(), need("result"), now)));
      break;
    case "list": {
      const read = worklog.read();
      for (const problem of [...read.problems, ...read.warnings]) console.error(`WORKLOG_WARNING ${problem}`);
      console.log(
        JSON.stringify(values["open"] ? read.items.filter((item) => item.closedAt === undefined) : read.items, null, 2),
      );
      break;
    }
    default:
      die("worklog needs add, next, note, close or list");
  }
};

const checkpoint: Command = async (cli) => {
  const { key, positionals, need, strings, lane, config } = cli;
  const target = await lane(key ?? die("checkpoint needs a lane key"));
  // parseArgs takes one value per flag; a second bare receipt would otherwise be dropped and its effect repeated later.
  const stray = positionals.slice(1);
  if (stray.length) die(`checkpoint: unexpected argument ${stray[0]}; give each receipt its own --remote-effect`);
  let provenance: ReportProvenance | undefined;
  let attributionReason = "No recorded launch invocation; remote effects retained without source attribution";
  try {
    provenance = runContext(new Reports(config.stateDir), target, process.env["DORI_LANE_RUN"])?.provenance;
  } catch (error) {
    if (!(error instanceof ReportError)) throw error;
    attributionReason = `Execution journal invalid: ${error.message}; remote effects retained without source attribution`;
  }
  const result = new Checkpoints(config.stateDir).write(
    target.key,
    {
      step: need("step"),
      result: need("result"),
      evidence: [need("evidence")],
      remoteEffects: strings("remote-effect"),
    },
    realClock.now(),
    provenance,
  );
  const receipt =
    target.requestId !== undefined && !result.checkpoint.provenance
      ? {
          ...result,
          attribution: {
            state: "unverified",
            reason: attributionReason,
          },
        }
      : result;
  console.log(JSON.stringify(receipt));
  autoTrackLinks(cli, target, result.checkpoint.remoteEffects.join(" "), `checkpoint ${target.key}`);
};

export const journalCommands: Readonly<Record<string, Command>> = {
  report,
  relayed,
  lesson,
  worklog,
  checkpoint,
  checkpoints: async ({ key, deps, config }) => {
    if (!key || !(await deps.registry.read(key))) die("checkpoints needs a registered lane key");
    console.log(JSON.stringify(new Checkpoints(config.stateDir).read(key ?? ""), null, 2));
  },
};
