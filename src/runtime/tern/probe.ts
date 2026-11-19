import type { Exec } from "../exec.ts";
import { interactiveShellInFront } from "../foreground.ts";
import { omoScreenIdle } from "../herdr/probe.ts";
import { isOmpProcess, withOmpState } from "../omp.ts";
import type { AgentStatus, ForegroundProcess, Probe } from "../types.ts";
import { idOf, layout, type TernBlock } from "./blocks.ts";
import { isMissing, ternCall } from "./exec.ts";

const GONE: Probe = { status: "gone", shellInFront: false };
/** A right-aligned hint (`⇧⇥ to change thinking effort`) starts this far into an empty input row, a draft right after `╰─ `. */
const HINT_INDENT = 8;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const pidOf = (value: unknown): number | undefined => {
  const pid = Number(idOf(value));
  return pid > 0 ? pid : undefined;
};

function processOf(value: unknown): ForegroundProcess | undefined {
  const p = rec(value);
  const name = typeof p?.["name"] === "string" && p["name"] !== "" ? p["name"] : undefined;
  if (p === undefined || name === undefined) return undefined;
  // As hc: a name-only hint holds delivery like any foreground, but is not bare-shell proof for close recovery.
  const raw = p["argv"];
  const argv = Array.isArray(raw) ? raw.filter((arg): arg is string => typeof arg === "string") : [name];
  const pid = pidOf(p["pid"]);
  return {
    name,
    argv,
    ...(pid === undefined ? {} : { pid }),
    ...(Array.isArray(raw) && argv.length === raw.length ? {} : { argvIncomplete: true }),
  };
}

/**
 * The draft in omp's input as the screen shows it: `""` for an empty input, the draft's text when one is there, and
 * undefined when no such input is recognised at the bottom of the screen (a dialog, a pager, another composer shape, a
 * native-UI omp, anything else). The input it knows is omp's classic one: a row starting `╰─` right below the status
 * row, holding the draft's first line (or, empty, at most a right-aligned hint), then the draft's indented continuation
 * rows. The older omo layout (rule, empty `❯`, rule) counts as empty too.
 */
export function ompDraft(screen: string): string | undefined {
  if (omoScreenIdle(screen)) return "";
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const at = lines.findLastIndex((l) => /^╰─(?: |$)/.test(l));
  if (at < 1 || lines[at - 1] === "") return undefined;
  const rest = lines.slice(at + 1);
  if (rest.some((l) => l !== "" && !l.startsWith("   "))) return undefined;
  // The row may close with the frame's own corner (`─╯`), which is not part of the draft.
  const first = (lines[at] ?? "").slice(2).replace(/\s*─?╯$/, "");
  const head = rest.length === 0 && new RegExp(`^ {${HINT_INDENT},}\\S`).test(first) ? "" : first.trim();
  return [head, ...rest.map((l) => l.trim())].join("\n").trim();
}

/**
 * One block's snapshot from its Tern record and `tern process`: the foreground decides shell or agent (#66), and an omp
 * in front is `working` while Tern's busy flag is set, else `idle`. Any other program has no status Tern can read, so
 * it is `unknown` and never typed into. A block Tern no longer has, or whose program has exited, is `gone`.
 */
export async function probeBlock(exec: Exec, block: TernBlock | undefined): Promise<Probe> {
  if (block === undefined || !block.live) return GONE;
  let info: Record<string, unknown>;
  try {
    info = await ternCall(exec, ["process", block.id]);
  } catch (e) {
    if (isMissing(e)) return GONE;
    throw e;
  }
  const fg = processOf(info["foreground"]);
  const foreground = fg === undefined ? undefined : [fg];
  const shellInFront = interactiveShellInFront(foreground);
  const omp = fg !== undefined && isOmpProcess(fg);
  const status: AgentStatus = shellInFront ? "shell" : !omp ? "unknown" : block.working ? "working" : "idle";
  const agent = omp ? "omp" : fg?.name;
  const [pgid, rootPid] = [pidOf(info["group"]), pidOf(rec(info["child"])?.["pid"])];
  return {
    status,
    ...(agent === undefined || shellInFront ? {} : { agent }),
    ...(pgid === undefined ? {} : { pgid }),
    ...(rootPid === undefined ? {} : { rootPid }),
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.cwd === undefined ? {} : { cwd: block.cwd }),
    shellInFront,
    ...(foreground === undefined ? {} : { foreground }),
  };
}

/** `probeBlock` for one id, then the live OMP record (approvals, session identity) when a state dir is given. */
export async function probe(exec: Exec, id: string, stateDir?: string): Promise<Probe> {
  const seen = await probeBlock(
    exec,
    (await layout(exec)).blocks.find((b) => b.id === id),
  );
  return stateDir === undefined ? seen : withOmpState(exec, stateDir, id, seen);
}
