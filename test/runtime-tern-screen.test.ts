import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLayout } from "../src/runtime/tern/blocks.ts";
import { TernError, ternCall } from "../src/runtime/tern/exec.ts";
import { ompDraft } from "../src/runtime/tern/probe.ts";
import { block, OMP, STATUS_ROW, ZSH } from "./fake-tern.ts";
import { B1, callsOf, rig } from "./tern-rig.ts";

// Rows shaped as `tern capture` returns them from omp's classic renderer (PI_TUI_NATIVE=0) in an 80-column block: the
// status row may or may not run on to a rule at its end, and an empty input is a bare `╰─` or carries a hint.
const RULED = " π > ◒ model > 🗑 /w ▶─1%─────────────────────────────────────┃──────1M─";
const HINT = `╰─${" ".repeat(50)}⇧⇥ to change thinking effort`;
const screen = (...rows: string[]): string => ["    Tip: a tip", "", STATUS_ROW, ...rows, "", ""].join("\n");

describe("ompDraft", () => {
  test.each([
    ["a bare empty input row", screen("╰─"), ""],
    ["an empty input with its hint", screen(HINT), ""],
    ["an empty input under a status row that ends in a rule", ["out", "", RULED, HINT].join("\n"), ""],
    ["a one-line draft", screen("╰─ hello zzqx world"), "hello zzqx world"],
    ["a draft over two rows", screen("╰─ line one", "   line two"), "line one\nline two"],
    ["a draft whose row closes with the frame's corner", screen("╰─ hello ─╯"), "hello"],
    ["a shell prompt", "/w via node\n❯ ", undefined],
    ["a row below the input that is not the draft's (a menu)", screen("╰─", "> /goal  set a goal"), undefined],
    ["an input row with nothing right above it", ["text", "", "╰─ x"].join("\n"), undefined],
    ["an input row at the top of the screen", "╰─ x", undefined],
    ["a frame's bottom border, which is no input row", screen("│ hello │", "╰──────────╯"), undefined],
    ["an empty screen", "", undefined],
    ["the older omo layout, empty", ["out", "─".repeat(20), "❯", "─".repeat(20), "footer"].join("\n"), ""],
  ] as const)("%s", (_, text, want) => {
    expect(ompDraft(text)).toBe(want);
  });
});

describe("read", () => {
  test("capture --scrollback, trailing blank rows dropped, the last N rows kept", async () => {
    const { fake, rt } = rig({ "5001": block({ draft: undefined, body: "a\nb\nc\n\n\n" }) });
    expect(await rt.read(B1, 2)).toBe("b\nc");
    expect(await rt.read(B1, 0)).toBe("c");
    expect(callsOf(fake, "capture")).toEqual([
      ["capture", "5001", "--scrollback"],
      ["capture", "5001", "--scrollback"],
    ]);
  });

  test("unwrapped joins rows as wide as the block, and only those", async () => {
    const { rt } = rig({ "5001": block({ draft: undefined, cols: 4, body: "abcd\nef\nxy" }) });
    expect(await rt.read(B1, 10, { unwrapped: true })).toBe("abcdef\nxy");
    expect(await rt.read(B1, 10)).toBe("abcd\nef\nxy");
  });

  test("a block Tern does not know throws its error", async () => {
    await expect(rig().rt.read(B1, 5)).rejects.toThrow("no block is called");
  });
});

/** A live OMP lane record for block 5001 and the `ps` evidence that its writer runs under the block's shell. */
function withRecord(over: { approvalPending?: boolean; agentStatus?: "idle" | "working" } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "dori-tern-omp-"));
  mkdirSync(join(stateDir, "sessions"));
  const record = {
    paneId: "5001",
    role: "lane",
    sessionId: "omp-session-1",
    pid: OMP.pid,
    startedAt: "2026-11-11T00:00:05Z",
    updatedAt: "2026-11-11T00:00:05Z",
    approvalPending: false,
    ...over,
  };
  writeFileSync(join(stateDir, "sessions", "5001.json"), JSON.stringify(record));
  const r = rig({ "5001": block() }, { stateDir });
  r.fake.knobs.ps = {
    table: `${ZSH.pid} 1 /bin/zsh -l\n${OMP.pid} ${ZSH.pid} ${OMP.argv.join(" ")}\n`,
    started: "2026-11-11T00:00:00Z",
  };
  return r;
}

describe("the live OMP record", () => {
  test("identity comes from the record; an idle record with an empty input is delivered", async () => {
    const { fake, rt } = withRecord({ agentStatus: "idle" });
    expect(await rt.probe(B1)).toMatchObject({ status: "idle", pid: OMP.pid, sessionId: "omp-session-1" });
    expect(await rt.deliver(B1, "hi")).toEqual({ kind: "delivered" });
    expect(fake.submitted).toEqual([{ id: "5001", text: "hi" }]);
  });

  test("an open approval holds delivery as blocked, even with force; nothing typed", async () => {
    const { fake, rt } = withRecord({ approvalPending: true });
    expect(await rt.deliver(B1, "hi", { force: true })).toEqual({ kind: "not-ready", status: "blocked" });
    expect(fake.pasted).toEqual([]);
  });

  test("the record's working beats Tern's idle flag", async () => {
    const { rt } = withRecord({ agentStatus: "working" });
    expect(await rt.deliver(B1, "hi")).toEqual({ kind: "not-ready", status: "working" });
  });

  test("a bound delivery reaches only the recorded session it names", async () => {
    const { fake, rt } = withRecord({ agentStatus: "idle" });
    const other = await rt.deliver(B1, "hi", { expectedSessionId: "omp-session-2" });
    expect(other).toEqual({ kind: "not-ready", status: "unknown" });
    expect(fake.pasted).toEqual([]);
    expect(await rt.deliver(B1, "hi", { expectedSessionId: "omp-session-1" })).toEqual({ kind: "delivered" });
  });

  test("an omp in front with no record of its own is unknown and never typed into", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "dori-tern-omp-"));
    const { fake, rt } = rig({ "5001": block() }, { stateDir });
    expect(await rt.deliver(B1, "hi")).toEqual({ kind: "not-ready", status: "unknown" });
    expect(fake.pasted).toEqual([]);
  });

  test("typed text is submitted only into the recorded session; an identity without one has changed", async () => {
    const { fake, rt } = withRecord({ agentStatus: "idle" });
    const b = fake.blocks.get("5001");
    if (b !== undefined) b.draft = "typed before";
    expect(await rt.submitTyped(B1, { agent: "omp", pgid: OMP.pid })).toBe("changed");
    expect(await rt.submitTyped(B1, { agent: "omp", pid: OMP.pid, sessionId: "another" })).toBe("changed");
    expect(fake.entered).toEqual([]);
    expect(await rt.submitTyped(B1, { agent: "omp", pid: OMP.pid, sessionId: "omp-session-1" })).toBe("submitted");
  });

  test("typeIntoShell refuses a block whose record names a live omp", async () => {
    const { fake, rt } = withRecord();
    const b = fake.blocks.get("5001");
    if (b !== undefined) b.foreground = ZSH;
    expect(await rt.typeIntoShell(B1, "ls")).toBe(false);
    expect(fake.ran).toEqual([]);
  });
});

describe("ternCall", () => {
  test("--json goes right before `--`, or last, so what follows the separator is taken verbatim", async () => {
    const seen: string[][] = [];
    const exec = async (_: string, argv: readonly string[]) => {
      seen.push([...argv]);
      return { code: 0, stdout: '{"block": 7}\n', stderr: "" };
    };
    expect(await ternCall(exec, ["send", "7", "paste", "--", "--json"])).toEqual({ block: 7 });
    await ternCall(exec, ["inspect"]);
    expect(seen).toEqual([
      ["send", "7", "paste", "--json", "--", "--json"],
      ["inspect", "--json"],
    ]);
  });

  test("an empty or non-object answer is an empty object", async () => {
    for (const stdout of ["", "\n", "[1]", "3"])
      expect(await ternCall(async () => ({ code: 0, stdout, stderr: "" }), ["close", "7"])).toEqual({});
  });

  test("a failure carries Tern's reason without its `tern <verb>:` prefix, and knows a missing target", async () => {
    const exec = async () => ({ code: 1, stdout: "", stderr: "tern process: no block is called `42`\n" });
    const err = (await ternCall(exec, ["process", "42"]).catch((e: unknown) => e)) as TernError;
    expect(err).toBeInstanceOf(TernError);
    expect(err.reason).toBe("no block is called `42`");
    expect(err.missing).toBe(true);
    const other = new TernError(["inspect", "--json"], { code: 1, stdout: "", stderr: "tern: no server\n" });
    expect([other.reason, other.missing]).toEqual(["no server", false]);
  });

  test("redacts the delivered text from the argv, the reason and the message", async () => {
    const exec = async () => ({ code: 1, stdout: "", stderr: "tern send: could not write secret text\n" });
    const err = (await ternCall(exec, ["send", "7", "paste", "--", "secret text"], { redact: "secret text" }).catch(
      (e: unknown) => e,
    )) as TernError;
    expect(err.argv).toEqual(["send", "7", "paste", "--json", "--", "<text>"]);
    expect(err.reason).toBe("could not write <text>");
    expect(err.message).not.toContain("secret text");
  });
});

describe("parseLayout", () => {
  test("reads Tern's own inspect shape: null for what a block lacks, the busy flag from the panes list", () => {
    const row = { cwd: "/w", program: "/bin/zsh", cols: 80, rows: 24, live: true, exited: null, file: null };
    const layout = parseLayout({
      sessions: [
        {
          id: 7001,
          name: "work",
          tabs: [
            { id: 9001, name: null, blocks: [{ ...row, id: 5001, title: "π > w" }] },
            {
              id: 9002,
              name: "Lane K",
              blocks: [
                { ...row, id: 5002, title: "" },
                { ...row, id: 5003, exited: 0 },
                { ...row, id: 5004, program: null, file: "/w/notes.md" },
                { ...row, id: "bad" },
              ],
            },
          ],
        },
        { name: "no id", tabs: [{ id: 1, blocks: [{ ...row, id: 2 }] }] },
      ],
      panes: [{ pane: 5001, working: true }, { pane: 5002, working: false }, { working: true }],
    });
    expect(layout.sessions).toEqual([{ id: "7001", name: "work" }]);
    expect(layout.blocks.map((b) => [b.id, b.tabId, b.tabName, b.title, b.live, b.working])).toEqual([
      ["5001", "9001", undefined, "π > w", true, true],
      ["5002", "9002", "Lane K", undefined, true, false],
      ["5003", "9002", "Lane K", undefined, false, false],
      ["5004", "9002", "Lane K", undefined, false, false],
    ]);
  });

  test("an answer with no sessions is an empty layout", () => {
    expect(parseLayout({})).toEqual({ sessions: [], blocks: [] });
  });
});
