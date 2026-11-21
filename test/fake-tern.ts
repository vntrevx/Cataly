// A recorder standing in for the `tern` binary: argv in, what `tern ... --json` prints out, over sessions of blocks.
// A block with a `draft` runs a program with an input (omp); paste and Enter act on that draft, and `composer` says
// whether the screen draws it the way omp's classic renderer does or in a shape the adapter does not know.
import type { Exec, ExecResult } from "../src/runtime/exec.ts";

export type FakeProc = { pid: number; name: string; argv: string[] };
export type FakeBlock = {
  session: string;
  tab: string;
  title?: string;
  cwd: string;
  cols: number;
  live: boolean;
  /** A note or file block: Tern lists it among a tab's blocks, with a file and no program. */
  file?: string;
  /** Tern's busy flag (the program's terminal progress). */
  working: boolean;
  child: FakeProc;
  group: number;
  foreground: FakeProc | null;
  /** Rows above the input. */
  body: string;
  /** The program's input: the draft it holds ("" = empty), or undefined when it has none (a dialog, a shell). */
  draft: string | undefined;
  composer: "classic" | "other";
};

export type FakeKnobs = {
  /** Every `send ... paste` fails with this message (a transport failure: some of it may have arrived). */
  pasteError?: string;
  /** This many Enter presses leave the draft where it is. */
  enterSwallowed?: number;
  /** Every `process` call fails with this message. */
  processError?: string;
  /** Every `rename` call fails with this message. */
  renameError?: string;
  /** `ps` output and exit code, for the OMP state check. */
  ps?: { table: string; started: string };
};

const ok = (value: unknown): ExecResult => ({ code: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" });
const fail = (verb: string, message: string, code = 1): ExecResult => ({
  code,
  stdout: "",
  stderr: `tern ${verb}: ${message}\n`,
});
const missing = (verb: string, id: string): ExecResult => fail(verb, `no block is called \`${id}\``);

export const ZSH: FakeProc = { pid: 100, name: "zsh", argv: ["/bin/zsh", "-l"] };
/** omp as `tern process` shows it: the process title is its version, the argv names the command. */
export const OMP: FakeProc = { pid: 101, name: "19.0.0", argv: ["omp", "--dori-role", "lane"] };

export function block(over: Partial<FakeBlock> = {}): FakeBlock {
  return {
    session: "work",
    tab: "9001",
    title: "π > w",
    cwd: "/w",
    cols: 80,
    live: true,
    working: false,
    child: ZSH,
    group: OMP.pid,
    foreground: OMP,
    body: "earlier output",
    draft: "",
    composer: "classic",
    ...over,
  };
}

/** The status row omp's classic renderer draws above its input in an 80-column block. */
export const STATUS_ROW = " π > 🖥 host > ◒ model > 🗑 /w ▶─2%───┃──1M─◀ (sub) < ⏱ 0:34";

/** The screen: the body, then the input as the block's composer draws it (classic: status row, `╰─` row, indented rows). */
export function screenOf(b: FakeBlock): string {
  if (b.draft === undefined) return b.body;
  const [first = "", ...more] = b.draft.split("\n");
  if (b.composer === "other") return [b.body, "", "─".repeat(40), `> ${first}`, ...more, STATUS_ROW].join("\n");
  const input = b.draft === "" ? "╰─" : `╰─ ${first}`;
  return [b.body, "", STATUS_ROW, input, ...more.map((l) => `   ${l}`), "", ""].join("\n");
}

export class FakeTern {
  readonly calls: string[][] = [];
  readonly pasted: { id: string; text: string }[] = [];
  /** Every Enter press, whatever it did. */
  readonly entered: string[] = [];
  readonly submitted: { id: string; text: string }[] = [];
  readonly ran: { id: string; command: string }[] = [];
  readonly sessions = new Map<string, string>([["work", "7001"]]);
  readonly tabNames = new Map<string, string>();
  readonly blocks = new Map<string, FakeBlock>();
  knobs: FakeKnobs = {};
  private next = 8000;

  constructor(initial: Record<string, FakeBlock> = {}) {
    for (const [id, b] of Object.entries(initial)) this.blocks.set(id, b);
  }

  readonly exec: Exec = async (cmd, argv) => {
    if (cmd === "ps") return this.ps(argv);
    const [at, cut] = [argv.indexOf("--json"), argv.indexOf("--")];
    if (cmd !== "tern" || at === -1 || (cut !== -1 && at > cut))
      throw new Error(`unexpected call ${cmd} ${argv.join(" ")}`);
    const args = argv.filter((_, i) => i !== at);
    this.calls.push(args);
    const [verb = "", id = ""] = args;
    if (verb === "inspect") return ok(this.inspect());
    if (verb === "new") return this.open(args);
    if (verb === "split") return this.blocks.has(id) ? this.open(args) : missing(verb, id);
    const b = this.blocks.get(id);
    if (b === undefined) return missing(verb, id);
    switch (verb) {
      case "process":
        if (this.knobs.processError) return fail(verb, this.knobs.processError);
        return ok({ pane: Number(id), child: { ...b.child, cwd: b.cwd }, group: b.group, foreground: b.foreground });
      case "capture":
        return ok({ block: Number(id), text: screenOf(b) });
      case "send":
        return this.send(id, b, args.slice(2));
      case "run":
        this.ran.push({ id, command: args.slice(args.indexOf("--") + 1).join(" ") });
        return ok({ block: Number(id) });
      case "rename":
        // Tern's rename takes the name as its last argument and refuses a `--` separator.
        if (args.length !== 3 || args.includes("--")) return fail(verb, "rename takes other arguments", 2);
        if (this.knobs.renameError) return fail(verb, this.knobs.renameError);
        this.tabNames.set(b.tab, args[2] ?? "");
        return ok({ block: Number(id) });
      case "close":
        this.blocks.delete(id);
        return ok({ block: Number(id) });
      default:
        return fail(verb, `unknown command ${verb}`);
    }
  };

  private inspect(): unknown {
    const sessions = [...this.sessions].map(([name, sid]) => {
      const tabs = new Map<string, unknown[]>();
      for (const [id, b] of this.blocks) {
        if (b.session !== name) continue;
        // Tern prints what a block does not have as null: no file for a terminal, no exit code while it runs.
        const row = {
          id: Number(id),
          title: b.title ?? "",
          cwd: b.cwd,
          program: b.file === undefined ? "/bin/zsh" : null,
          cols: b.cols,
          rows: 24,
          live: b.live,
          exited: b.live ? null : 0,
          file: b.file ?? null,
        };
        tabs.set(b.tab, [...(tabs.get(b.tab) ?? []), row]);
      }
      return {
        id: Number(sid),
        name,
        tabs: [...tabs].map(([tid, blocks]) => ({ id: Number(tid), name: this.tabNames.get(tid) ?? null, blocks })),
      };
    });
    const panes = [...this.blocks]
      .filter(([, b]) => b.file === undefined)
      .map(([id, b]) => ({ pane: Number(id), working: b.working, quiet_ms: 0, omp_session_file: null }));
    return { sessions, panes, clients: [], detached: [] };
  }

  private open(args: string[]): ExecResult {
    const [verb, kind, target = ""] = args;
    let session: string;
    if (verb === "split") session = this.blocks.get(kind ?? "")?.session ?? "";
    else if (kind === "tab") {
      const named = [...this.sessions].find(([name, sid]) => sid === target || name === target);
      if (named === undefined) return fail("new", `no session is called \`${target}\``);
      session = named[0];
    } else {
      if (this.sessions.has(target)) return fail("new", `a session is already called \`${target}\``);
      this.sessions.set(target, String(this.next++));
      session = target;
    }
    const [id, tab] = [String(this.next++), String(this.next++)];
    const cwd = args[args.indexOf("--cwd") + 1] ?? "/";
    this.blocks.set(id, block({ session, tab, cwd, foreground: ZSH, group: ZSH.pid, draft: undefined, body: "$ " }));
    return ok({ session: Number(this.sessions.get(session)), tab: Number(tab), block: Number(id) });
  }

  private send(id: string, b: FakeBlock, rest: string[]): ExecResult {
    const [how, ...words] = rest;
    if (how === "paste") {
      if (this.knobs.pasteError) return fail("send", this.knobs.pasteError);
      const text = words.slice(words.indexOf("--") + 1).join(" ");
      this.pasted.push({ id, text });
      if (b.draft !== undefined) b.draft += text;
      return ok({ block: Number(id) });
    }
    if (how !== "keys") return fail("send", `unknown send ${how ?? ""}`);
    for (const key of words) {
      if (key !== "enter") continue;
      this.entered.push(id);
      if (b.draft === undefined || b.draft === "") continue;
      if ((this.knobs.enterSwallowed ?? 0) > 0) {
        this.knobs.enterSwallowed = (this.knobs.enterSwallowed ?? 0) - 1;
        continue;
      }
      this.submitted.push({ id, text: b.draft });
      b.draft = "";
      b.working = true;
    }
    return ok({ block: Number(id) });
  }

  private ps(argv: readonly string[]): ExecResult {
    const ps = this.knobs.ps;
    if (ps === undefined) return { code: 1, stdout: "", stderr: "ps: not modelled\n" };
    return { code: 0, stdout: argv.includes("lstart=") ? `${ps.started}\n` : ps.table, stderr: "" };
  }
}
