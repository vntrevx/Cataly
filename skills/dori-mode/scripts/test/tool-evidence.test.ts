import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EvidenceError } from "../src/evidence.ts";
import { hasDoriCommand } from "../src/monitor-command.ts";
import { toolEvidence } from "../src/tool-evidence.ts";

// The session cwd each call was called in: a work directory, and the skill's scripts directory, where `bun src/cli.ts`
// is the Dori CLI.
const CWD = "/work/app";
const SCRIPTS = join(import.meta.dir, "..");
const CHECKPOINT = "bun src/cli.ts checkpoint lane --step s --result ok";
const CHECKPOINT_JSON = '{"checkpoint":{"step":"s","result":"ok"}}';

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      { type: "toolCall", id, name, arguments: args },
    ],
  },
});
const result = (id: string, name: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
    ...extra,
  },
});

describe("tool evidence", () => {
  test("a rerun with the same result, at another time and wall time, is the same evidence; new output is not", () => {
    const branch = [
      call("c1", "bash", { command: "bun test" }),
      result("c1", "bash", "12 pass", { details: { wallTimeMs: 10 } }),
      call("c2", "bash", { command: "bun test" }),
      result("c2", "bash", "12 pass\n\nWall time: 31.20 seconds", {
        timestamp: 99,
        details: { wallTimeMs: 31_200, wallTimeNoticeEmitted: true },
      }),
      call("c3", "bash", { command: "bun test" }),
      result("c3", "bash", "13 pass"),
    ];
    const first = toolEvidence(branch, "c1", CWD);
    expect(first).toEqual({ kind: "tool", ref: "c1", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(toolEvidence(branch, "c2", CWD).fingerprint).toBe(first.fingerprint);
    expect(toolEvidence(branch, "c3", CWD).fingerprint).not.toBe(first.fingerprint);
  });

  test("structured result data is evidence even when the display text stays the same", () => {
    const branch = [
      call("c1", "measure"),
      result("c1", "measure", "measurement ready", { details: { rows: 12 } }),
      call("c2", "measure"),
      result("c2", "measure", "measurement ready", { details: { rows: 13 } }),
    ];
    expect(toolEvidence(branch, "c2", CWD).fingerprint).not.toBe(toolEvidence(branch, "c1", CWD).fingerprint);
  });

  test.each([
    ["Wall time: 1 seconds", "Wall time: 2 seconds"],
    ["same", "same\n"],
  ])("preserves result data %s rather than treating it as runtime metadata", (first, second) => {
    const branch = [call("c1", "read"), result("c1", "read", first), call("c2", "read"), result("c2", "read", second)];
    expect(toolEvidence(branch, "c2", CWD).fingerprint).not.toBe(toolEvidence(branch, "c1", CWD).fingerprint);
  });

  test.each([
    ["absent from the current branch", [call("other", "bash")], "no completed result"],
    ["without a result", [call("c1", "bash")], "no completed result"],
    ["failed", [call("c1", "bash"), result("c1", "bash", "boom", { isError: true })], "it failed"],
    ["pruned", [call("c1", "read"), result("c1", "read", "[pruned]", { prunedAt: 5 })], "pruned"],
    [
      "a background start",
      [call("c1", "bash"), result("c1", "bash", "Backgrounded", { details: { async: { state: "running" } } })],
      "background",
    ],
    ["a result of another tool", [call("c1", "bash"), result("c1", "read", "x")], "another tool"],
    ["the report tool", [call("c1", "dori_report"), result("c1", "dori_report", "ok")], "coordinates"],
    [
      "a shell run of the report CLI",
      [
        call("c1", "bash", { command: 'line=$(bun /x/skills/dori-mode/scripts/src/cli.ts report k --kind "$kind")' }),
        result("c1", "bash", "done"),
      ],
      "coordinates",
    ],
    ...[
      "env dori checkpoint lane --step s --result ok --evidence proof",
      "DORI_CONFIG=x bun /x/skills/dori-mode/scripts/src/cli.ts checkpoint lane",
      'timeout 10 env -i bun "/x with spaces/skills/dori-mode/scripts/src/cli.ts" checkpoint lane',
      'bash -lc "env dori checkpoint lane --step s --result ok --evidence proof"',
    ].map(
      (command) =>
        [
          `a wrapped coordination command: ${command}`,
          [call("c1", "bash", { command }), result("c1", "bash", '{"checkpoint":{"step":"s"}}')],
          "coordinates",
        ] as const,
    ),
    [
      "a dori message",
      [call("c1", "bash", { command: "dori send discord --text hi" }), result("c1", "bash", "ok")],
      "coordinates",
    ],
    ["an agent message", [call("c1", "write", { path: "agent://Main" }), result("c1", "write", "ok")], "coordinates"],
    [
      "a printed report line",
      [call("c1", "bash", { command: "cat log" }), result("c1", "bash", "x\n[REPORT] k | milestone | y")],
      "coordinates",
    ],
  ])("refuses a call %s", (_why, branch, message) => {
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow(message);
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow(EvidenceError);
  });

  test.each([
    { name: "bash", args: { command: "printf '%s' 'dori report lane' > docs/usage.md" }, text: "" },
    { name: "bash", args: { command: "rg -F 'dori report lane' docs/usage.md" }, text: "dori report lane" },
    { name: "write", args: { path: "docs/usage.md", content: "Use `dori report lane`." }, text: "written" },
    {
      name: "edit",
      args: { path: "docs/usage.md", old_string: "before", new_string: "`dori report lane`" },
      text: "edited",
    },
    { name: "read", args: { path: "docs/usage.md" }, text: "[REPORT] lane | milestone | example" },
    { name: "write", args: { path: "docs/protocol.md", content: "agent://Main" }, text: "written" },
  ])("file data mentioning coordination is still work: %j", ({ name, args, text }) => {
    expect(toolEvidence([call("file", name, args), result("file", name, text)], "file", CWD).kind).toBe("tool");
  });

  test("a command that only mentions dori is work", () => {
    const branch = [call("c1", "bash", { command: "rg dori src" }), result("c1", "bash", "src/a.ts: dori")];
    expect(toolEvidence(branch, "c1", CWD).kind).toBe("tool");
  });
});

describe("a command is read in the directory it started in", () => {
  test("a relative CLI run without its own cwd is read in the session cwd it was called in", () => {
    const branch = [call("c1", "bash", { command: CHECKPOINT }), result("c1", "bash", CHECKPOINT_JSON)];
    expect(() => toolEvidence(branch, "c1", SCRIPTS)).toThrow("coordinates");
    // The same words run another program elsewhere; the same output from a work command is work.
    expect(toolEvidence(branch, "c1", CWD).kind).toBe("tool");
    const shown = [call("c2", "bash", { command: "cat checkpoint.json" }), result("c2", "bash", CHECKPOINT_JSON)];
    expect(toolEvidence(shown, "c2", SCRIPTS).kind).toBe("tool");
  });

  test("its own cwd is read where omp resolved it into details.cwd, not in the session cwd", () => {
    const own = (cwd: string, resolved?: string) => [
      call("c1", "bash", { command: CHECKPOINT, cwd }),
      result("c1", "bash", CHECKPOINT_JSON, resolved === undefined ? {} : { details: { cwd: resolved } }),
    ];
    const root = join(SCRIPTS, "../../..");
    expect(() => toolEvidence(own("skills/dori-mode/scripts", SCRIPTS), "c1", root)).toThrow("coordinates");
    expect(toolEvidence(own("app", join(SCRIPTS, "app")), "c1", SCRIPTS).kind).toBe("tool");
    expect(() => toolEvidence(own("skills/dori-mode/scripts"), "c1", root)).toThrow("did not see");
  });

  test("a leading cd that omp hoisted into details.cwd moves the session cwd once", () => {
    const branch = [
      call("c1", "bash", { command: `cd scripts && ${CHECKPOINT}` }),
      result("c1", "bash", CHECKPOINT_JSON, { details: { cwd: SCRIPTS } }),
    ];
    expect(() => toolEvidence(branch, "c1", join(SCRIPTS, ".."))).toThrow("coordinates");
    // With an explicit cwd, the pinned host does not hoist the leading cd.
    const explicit = [
      call("c1", "bash", { command: `cd scripts && ${CHECKPOINT}`, cwd: join(SCRIPTS, "..") }),
      result("c1", "bash", CHECKPOINT_JSON, { details: { cwd: join(SCRIPTS, "..") } }),
    ];
    expect(() => toolEvidence(explicit, "c1", undefined)).toThrow("coordinates");
  });

  test.each(["true &&", "false ||"])("a possible CLI directory after %s cannot establish work", (prefix) => {
    const command = `${prefix} cd skills/dori-mode/scripts; ${CHECKPOINT}`;
    const branch = [call("conditional", "bash", { command }), result("conditional", "bash", CHECKPOINT_JSON)];
    const root = join(SCRIPTS, "../../..");
    expect(hasDoriCommand(command, root)).toBe(false);
    expect(hasDoriCommand(command, root, true)).toBe(true);
    expect(() => toolEvidence(branch, "conditional", root)).toThrow("coordinates");
    const work = [
      call("work", "bash", { command: `${prefix} cd app; bun src/cli.ts test` }),
      result("work", "bash", "12 pass"),
    ];
    expect(toolEvidence(work, "work", CWD).kind).toBe("tool");
  });

  test("a command whose session cwd this process did not see is refused; other tools need none", () => {
    const work = [call("c1", "bash", { command: "bun test" }), result("c1", "bash", "12 pass")];
    expect(() => toolEvidence(work, "c1", undefined)).toThrow("did not see");
    const named = [call("c1", "bash", { command: "dori checkpoint lane" }), result("c1", "bash", CHECKPOINT_JSON)];
    expect(() => toolEvidence(named, "c1", undefined)).toThrow("coordinates");
    const read = [call("c1", "read", { path: "src/cli.ts" }), result("c1", "read", CHECKPOINT)];
    expect(toolEvidence(read, "c1", undefined).kind).toBe("tool");
  });

  test.each([`printf '%s\\n' '${CHECKPOINT}' > docs/usage.md`, `rg -F '${CHECKPOINT}' docs`])(
    "quoted CLI words run in the skill directory are data: %s",
    (command) => {
      const branch = [call("c1", "bash", { command }), result("c1", "bash", CHECKPOINT)];
      expect(toolEvidence(branch, "c1", SCRIPTS).kind).toBe("tool");
    },
  );
});
