import { describe, expect, test } from "bun:test";
import type { Exec } from "../src/runtime/exec.ts";
import { ENTER_ATTEMPTS, PASTE_SETTLE_MS } from "../src/runtime/herdr/deliver.ts";
import { SUBMIT_CHECK_MS } from "../src/runtime/tern/deliver.ts";
import { TernRuntime } from "../src/runtime/tern/index.ts";
import { block, type FakeBlock, FakeTern, ZSH } from "./fake-tern.ts";
import { B1, callsOf, rig } from "./tern-rig.ts";

const typedCalls = (fake: FakeTern) => fake.calls.filter((c) => c[0] === "send" || c[0] === "run");
const VIM = { pid: 7, name: "vim", argv: ["vim"] };

/** A runtime whose block changes right after the paste lands (`change` is applied to it), as a live screen can. */
function changingAfterPaste(initial: FakeBlock, change: Partial<FakeBlock>, paste = true) {
  const fake = new FakeTern({ "5001": initial });
  const exec: Exec = async (cmd, argv) => {
    const pasting = argv.includes("paste");
    const result = pasting && !paste ? { code: 0, stdout: "{}", stderr: "" } : await fake.exec(cmd, argv);
    const b = fake.blocks.get("5001");
    if (pasting && b !== undefined) Object.assign(b, change);
    return result;
  };
  return { fake, rt: new TernRuntime(exec, { env: {}, sleep: async () => {} }) };
}

describe("deliver", () => {
  test("idle omp with an empty input: one paste, settle, Enter; delivered once the input reads empty", async () => {
    const { fake, rt, sleeps } = rig({ "5001": block() });
    expect(await rt.deliver(B1, "hello\nsecond line")).toEqual({ kind: "delivered" });
    expect(typedCalls(fake)).toEqual([
      ["send", "5001", "paste", "--", "hello\nsecond line"],
      ["send", "5001", "keys", "enter"],
    ]);
    expect(fake.submitted).toEqual([{ id: "5001", text: "hello\nsecond line" }]);
    expect(sleeps).toEqual([PASTE_SETTLE_MS, SUBMIT_CHECK_MS]);
  });

  test("the text is one argv element after `--`: nothing in it is read as an option", async () => {
    const { fake, rt } = rig({ "5001": block() });
    expect((await rt.deliver(B1, "--json $(id) `x`")).kind).toBe("delivered");
    expect(fake.pasted).toEqual([{ id: "5001", text: "--json $(id) `x`" }]);
  });

  test.each([
    ["a shell in front", block({ foreground: ZSH }), { kind: "no-agent" }],
    ["an exited block", block({ live: false }), { kind: "no-agent" }],
    ["another program in front", block({ foreground: VIM }), { kind: "not-ready", status: "unknown" }],
    ["omp busy under when=idle", block({ working: true }), { kind: "not-ready", status: "working" }],
    ["a person's draft in the input", block({ draft: "half a thought" }), { kind: "not-ready", status: "unknown" }],
    ["a draft over several rows", block({ draft: "one\ntwo" }), { kind: "not-ready", status: "unknown" }],
  ] as const)("%s: nothing typed", async (_, b, want) => {
    const { fake, rt } = rig({ "5001": b });
    expect(await rt.deliver(B1, "secret text")).toEqual(want);
    expect(typedCalls(fake)).toEqual([]);
  });

  test("a block Tern does not know is no-agent; a failed probe holds the message as unknown", async () => {
    expect(await rig().rt.deliver(B1, "x")).toEqual({ kind: "no-agent" });
    const { fake, rt } = rig({ "5001": block() });
    fake.knobs.processError = "daemon not running";
    expect(await rt.deliver(B1, "x")).toEqual({ kind: "not-ready", status: "unknown" });
    expect(typedCalls(fake)).toEqual([]);
  });

  test("when=working types into a busy omp; when=any into either; when=working holds an idle one", async () => {
    const busy = rig({ "5001": block({ working: true }) });
    expect((await busy.rt.deliver(B1, "/goal pause", { when: "working" })).kind).toBe("delivered");
    const any = rig({ "5001": block({ working: true }) });
    expect((await any.rt.deliver(B1, "x", { when: "any" })).kind).toBe("delivered");
    expect((await rig({ "5001": block() }).rt.deliver(B1, "x", { when: "any" })).kind).toBe("delivered");
    const idle = rig({ "5001": block() });
    expect(await idle.rt.deliver(B1, "x", { when: "working" })).toEqual({ kind: "not-ready", status: "idle" });
    expect(typedCalls(idle.fake)).toEqual([]);
  });

  test("strictIdle holds a busy omp even under when=any; without it the same block is delivered", async () => {
    const { fake, rt } = rig({ "5001": block({ working: true }) });
    expect(await rt.deliver(B1, "nudge", { when: "any", strictIdle: true })).toEqual({
      kind: "not-ready",
      status: "working",
    });
    expect(typedCalls(fake)).toEqual([]);
    expect((await rt.deliver(B1, "next", { when: "any", strictIdle: false })).kind).toBe("delivered");
  });

  test("strictIdle: omp that starts working after the paste gets no Enter, the text is typed", async () => {
    const { fake, rt } = changingAfterPaste(block(), { working: true });
    const out = await rt.deliver(B1, "nudge", { strictIdle: true });
    expect(out).toMatchObject({ kind: "typed", into: { agent: "omp", pgid: 101 } });
    expect(fake.entered).toEqual([]);
  });

  test("a failed paste may have typed some of it: ambiguous, its detail never carries the text, no Enter", async () => {
    const { fake, rt } = rig({ "5001": block() });
    fake.knobs.pasteError = "broken pipe near the secret";
    const out = await rt.deliver(B1, "the secret");
    expect(out.kind).toBe("ambiguous");
    expect(JSON.stringify(out)).not.toContain("the secret");
    expect(out).toMatchObject({ detail: "tern send paste failed: broken pipe near <text>" });
    expect(fake.entered).toEqual([]);
  });

  test("a block that closes under the paste is no-agent", async () => {
    const fake = new FakeTern({ "5001": block() });
    const exec: Exec = async (cmd, argv) => {
      if (argv.includes("paste")) fake.blocks.delete("5001");
      return fake.exec(cmd, argv);
    };
    const rt = new TernRuntime(exec, { env: {}, sleep: async () => {} });
    expect(await rt.deliver(B1, "x")).toEqual({ kind: "no-agent" });
  });

  test("a swallowed Enter is pressed again while the draft stays; every one swallowed is typed", async () => {
    const once = rig({ "5001": block() });
    once.fake.knobs.enterSwallowed = 1;
    expect(await once.rt.deliver(B1, "x")).toEqual({ kind: "delivered" });
    expect(once.fake.entered).toHaveLength(2);
    expect(once.fake.submitted).toEqual([{ id: "5001", text: "x" }]);

    const never = rig({ "5001": block() });
    never.fake.knobs.enterSwallowed = ENTER_ATTEMPTS;
    const out = await never.rt.deliver(B1, "x");
    expect(out).toMatchObject({ kind: "typed", into: { agent: "omp", pgid: 101 } });
    expect(never.fake.entered).toHaveLength(ENTER_ATTEMPTS);
    expect(never.fake.pasted).toHaveLength(1);
  });

  test.each([
    ["the agent left and its shell is in front", { foreground: ZSH }, true],
    ["another agent took the block", { group: 999 }, true],
    ["the input is no longer recognisable (a dialog opened)", { composer: "other" }, true],
    ["the pasted text never showed in the input", {}, false],
  ] as const)("after the paste, %s: no Enter, typed and kept for reconciliation", async (_, change, paste) => {
    const { fake, rt } = changingAfterPaste(block(), change, paste);
    const out = await rt.deliver(B1, "x");
    expect(out).toMatchObject({ kind: "typed", into: { agent: "omp", pgid: 101 } });
    expect(fake.entered).toEqual([]);
  });
});

describe("deliver into an input the screen does not show", () => {
  test("a composer the adapter does not know: paste, settle, the same agent, one Enter (herdr's rule)", async () => {
    const { fake, rt, sleeps } = rig({ "5001": block({ composer: "other" }) });
    expect(await rt.deliver(B1, "hello")).toEqual({ kind: "delivered" });
    expect(typedCalls(fake)).toEqual([
      ["send", "5001", "paste", "--", "hello"],
      ["send", "5001", "keys", "enter"],
    ]);
    expect(fake.submitted).toEqual([{ id: "5001", text: "hello" }]);
    expect(sleeps).toEqual([PASTE_SETTLE_MS]);
  });

  test("the status gates still hold it: a busy agent under when=idle gets nothing", async () => {
    const { fake, rt } = rig({ "5001": block({ composer: "other", working: true }) });
    expect(await rt.deliver(B1, "x")).toEqual({ kind: "not-ready", status: "working" });
    expect(typedCalls(fake)).toEqual([]);
  });

  test("an agent that left between paste and Enter gets no Enter", async () => {
    const { fake, rt } = changingAfterPaste(block({ composer: "other" }), { foreground: ZSH });
    expect((await rt.deliver(B1, "x")).kind).toBe("typed");
    expect(fake.entered).toEqual([]);
  });

  test("an Enter Tern refuses every time is typed, the text kept", async () => {
    const fake = new FakeTern({ "5001": block({ composer: "other" }) });
    const exec: Exec = async (cmd, argv) =>
      argv.includes("keys") ? { code: 1, stdout: "", stderr: "tern send: busy\n" } : fake.exec(cmd, argv);
    const out = await new TernRuntime(exec, { env: {}, sleep: async () => {} }).deliver(B1, "x");
    expect(out.kind === "typed" && String(out.failure)).toContain("busy");
  });
});

describe("submitTyped", () => {
  const into = { agent: "omp", pgid: 101 };

  test("the same agent with the text still in its input: only Enter, submitted", async () => {
    const { fake, rt } = rig({ "5001": block({ draft: "typed before" }) });
    expect(await rt.submitTyped(B1, into)).toBe("submitted");
    expect(typedCalls(fake)).toEqual([["send", "5001", "keys", "enter"]]);
    expect(fake.submitted).toEqual([{ id: "5001", text: "typed before" }]);
  });

  test("an input the screen does not show: the same agent gets one Enter", async () => {
    const { fake, rt } = rig({ "5001": block({ composer: "other", draft: "typed before" }) });
    expect(await rt.submitTyped(B1, into)).toBe("submitted");
    expect(fake.entered).toEqual(["5001"]);
  });

  test.each([
    ["a shell", block({ foreground: ZSH, draft: "x" }), "changed"],
    ["another agent group", block({ group: 999, draft: "x" }), "changed"],
    ["an empty input (the text is not there)", block(), "changed"],
    ["another program in front", block({ foreground: VIM, draft: "x" }), "wait"],
    ["an exited block", block({ live: false }), "wait"],
  ] as const)("%s: %s, nothing pressed", async (_, b, want) => {
    const { fake, rt } = rig({ "5001": b });
    expect(await rt.submitTyped(B1, into)).toBe(want);
    expect(typedCalls(fake)).toEqual([]);
  });

  test("Enter that never takes throws, so the caller keeps the entry", async () => {
    const { fake, rt } = rig({ "5001": block({ draft: "x" }) });
    fake.knobs.enterSwallowed = ENTER_ATTEMPTS;
    await expect(rt.submitTyped(B1, into)).rejects.toThrow("still in the input");
    expect(fake.pasted).toEqual([]);
  });
});

describe("typeIntoShell and keys", () => {
  test("only a shell gets `tern run`; an agent gets nothing and false", async () => {
    const shell = rig({ "5001": block({ foreground: ZSH, draft: undefined }) });
    expect(await shell.rt.typeIntoShell(B1, "ls -la")).toBe(true);
    expect(callsOf(shell.fake, "run")).toEqual([["run", "5001", "--", "ls -la"]]);
    const agent = rig({ "5001": block() });
    expect(await agent.rt.typeIntoShell(B1, "ls")).toBe(false);
    expect(agent.fake.ran).toEqual([]);
  });

  test("keys map to Tern's names in one call; no keys, no call", async () => {
    const { fake, rt } = rig({ "5001": block() });
    await rt.keys(B1, ["escape", "enter"]);
    await rt.keys(B1, []);
    expect(callsOf(fake, "send")).toEqual([["send", "5001", "keys", "esc", "enter"]]);
  });
});
