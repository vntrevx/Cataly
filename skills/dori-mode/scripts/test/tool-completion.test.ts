import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { COMPLETION_ENTRY, completionReceipt, toolEvidence } from "../src/tool-evidence.ts";

type Entry = { type: string; customType?: string; data?: unknown; message?: unknown };

const call = (id: string, args: Record<string, unknown> = {}): Entry => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }] },
});
const result = (id: string, text: string, details: Record<string, unknown>): Entry => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    details,
    isError: false,
    timestamp: 1,
  },
});
// OMP 18.20.0 bash (src/tools/bash.ts): the call returns #buildBackgroundStartResult (details.async running), and the
// job's report() then sends its settled frame through onUpdate: the completed result's text and details (`output`
// left out) with details.async.
const started = (id: string, job: string): Entry =>
  result(id, `Background job ${job} started`, { async: { state: "running", jobId: job, type: "bash" } });
const frame = (text: string, state = "completed", job = "j1", details: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text }],
  details: {
    wallTimeNoticeEmitted: false,
    wallTimeMs: 20,
    timeoutSeconds: 300,
    ...details,
    async: { state, jobId: job, type: "bash" },
  },
});
// The session cwd a call started in: a work directory, and the skill's scripts directory.
const CWD = "/work/app";
const SCRIPTS = join(import.meta.dir, "..");
const receipt = (branch: Entry[], id: string, partial: unknown, cwd = CWD): Entry => ({
  type: "custom",
  customType: COMPLETION_ENTRY,
  data: completionReceipt(branch, id, "bash", partial, cwd),
});

describe("background tool evidence", () => {
  test("a background job is evidence through its completion receipt, as the same output run in the foreground", () => {
    const branch = [call("c1", { command: "bun test", async: true }), started("c1", "j1")];
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow("records no successful completion of its job");
    branch.push(receipt(branch, "c1", frame("12 pass")));
    const sync = [call("s1", { command: "bun test" }), result("s1", "12 pass", { timeoutSeconds: 300, wallTimeMs: 5 })];
    expect(toolEvidence(branch, "c1", CWD)).toEqual({
      kind: "tool",
      ref: "c1",
      fingerprint: toolEvidence(sync, "s1", CWD).fingerprint,
    });

    // A rerun under a new call, job and wall time is the same evidence; new output is new.
    branch.push(call("c2", { command: "bun test", async: true }), started("c2", "j7"));
    const timed = { wallTimeNoticeEmitted: true, wallTimeMs: 3000 };
    branch.push(receipt(branch, "c2", frame("12 pass\n\nWall time: 3.00 seconds", "completed", "j7", timed)));
    expect(toolEvidence(branch, "c2", CWD).fingerprint).toBe(toolEvidence(branch, "c1", CWD).fingerprint);
    branch.push(call("c3", { command: "bun test", async: true }), started("c3", "j8"));
    branch.push(receipt(branch, "c3", frame("13 pass", "completed", "j8")));
    expect(toolEvidence(branch, "c3", CWD).fingerprint).not.toBe(toolEvidence(branch, "c1", CWD).fingerprint);
  });

  test("images the completed frame carries in details are content, as in a foreground result", () => {
    const image = { type: "image", mimeType: "image/png", data: "AAAA" };
    const branch = [call("c1"), started("c1", "j1")];
    branch.push(receipt(branch, "c1", frame("chart", "completed", "j1", { images: [image] })));
    const content = [{ type: "text", text: "chart" }, image];
    const details = { timeoutSeconds: 300 };
    const shown = { role: "toolResult", toolCallId: "s1", toolName: "bash", content, details, isError: false };
    const sync: Entry[] = [call("s1"), { type: "message", message: shown }];
    expect(toolEvidence(branch, "c1", CWD).fingerprint).toBe(toolEvidence(sync, "s1", CWD).fingerprint);
  });

  test.each(["running", "failed", "cancelled"])("a %s frame records no receipt", (state) => {
    const branch = [call("c1"), started("c1", "j1")];
    expect(completionReceipt(branch, "c1", "bash", frame("partial", state), CWD)).toBeUndefined();
  });

  test("a completion of a call off the branch, of another tool, or without a job records no receipt", () => {
    const branch = [call("c1"), started("c1", "j1")];
    expect(completionReceipt(branch, "elsewhere", "bash", frame("12 pass"), CWD)).toBeUndefined();
    expect(completionReceipt(branch, "c1", "read", frame("12 pass"), CWD)).toBeUndefined();
    expect(completionReceipt(branch, "c1", "bash", frame("12 pass", "completed", ""), CWD)).toBeUndefined();
    expect(completionReceipt(branch, "c1", "bash", { ...frame("12 pass"), isError: true }, CWD)).toBeUndefined();
  });

  test("a receipt counts only for its own call and job on this branch; the batched async-result never does", () => {
    const base = [call("c1"), started("c1", "j1"), call("c2"), started("c2", "j2")];
    const other = receipt(base, "c2", frame("12 pass", "completed", "j2"));
    const wrongJob = receipt(base, "c1", frame("12 pass", "completed", "j2"));
    // omp's async-job-delivery batch: one custom message for several jobs, with no per-job result.
    const batch: Entry = {
      type: "message",
      message: {
        role: "custom",
        customType: "async-result",
        content: "j1 completed: 12 pass\nj2 completed: 12 pass",
        details: { jobs: [{ jobId: "j1", status: "completed" }] },
      },
    };
    const forged: Entry = {
      type: "custom",
      customType: COMPLETION_ENTRY,
      data: { call: "c1", job: "j1", tool: "bash", cwd: CWD },
    };
    // A receipt that does not say which session cwd its call started in.
    const placed = receipt(base, "c1", frame("12 pass")).data as Record<string, unknown>;
    const unplaced: Entry = { type: "custom", customType: COMPLETION_ENTRY, data: { ...placed, cwd: undefined } };
    for (const entry of [other, wrongJob, batch, forged, unplaced])
      expect(() => toolEvidence([...base, entry], "c1", CWD)).toThrow("records no successful completion of its job");
    expect(toolEvidence([...base, other], "c2", CWD).kind).toBe("tool");
  });

  test("a legacy start without a job id is never completed by guess", () => {
    const branch = [call("c1"), result("c1", "Backgrounded", { async: { state: "running" } })];
    branch.push({ type: "custom", customType: COMPLETION_ENTRY, data: { call: "c1", job: "", tool: "bash" } });
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow("background");
  });

  test("a wrapped coordination job cannot create a successful evidence receipt", () => {
    const branch = [call("c1", { command: "env dori checkpoint lane", async: true }), started("c1", "j1")];
    const completed = receipt(branch, "c1", frame('{"checkpoint":{"step":"s"}}'));
    expect(completed.data).toHaveProperty("refused");
    branch.push(completed);
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow("coordinates");
  });

  test("a background command writing quoted command data remains evidence", () => {
    const branch = [
      call("c1", { command: "printf '%s' 'dori report lane' > docs/usage.md", async: true }),
      started("c1", "j1"),
    ];
    branch.push(receipt(branch, "c1", frame("written")));
    expect(toolEvidence(branch, "c1", CWD).kind).toBe("tool");
  });

  test("a background run whose completed output reports is refused", () => {
    const branch = [call("c1", { command: "cat log" }), started("c1", "j1")];
    branch.push(receipt(branch, "c1", frame("[REPORT] k | milestone | y")));
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow("coordinates");
  });

  test("a background relative CLI is read where its call started, as its receipt records", () => {
    const command = "bun src/cli.ts checkpoint lane --step s --result ok";
    const output = '{"checkpoint":{"step":"s"}}';
    const branch = [call("c1", { command, async: true }), started("c1", "j1")];
    const completed = receipt(branch, "c1", frame(output), SCRIPTS);
    expect(structuredClone(completed.data)).toMatchObject({
      cwd: SCRIPTS,
      refused: expect.stringContaining("coordinates"),
    });
    branch.push(completed);
    // The receipt's session cwd places the call, not the one dori_report passes.
    expect(() => toolEvidence(branch, "c1", CWD)).toThrow("coordinates");
    const elsewhere = [call("c2", { command, async: true }), started("c2", "j2")];
    elsewhere.push(receipt(elsewhere, "c2", frame(output, "completed", "j2")));
    expect(toolEvidence(elsewhere, "c2", SCRIPTS).kind).toBe("tool");

    // Its own cwd is read where omp resolved it, in the start result's and completed frame's details.cwd.
    const job = { async: { state: "running", jobId: "j3", type: "bash" }, cwd: SCRIPTS };
    const own = [call("c3", { command, cwd: "scripts", async: true }), result("c3", "Background job j3 started", job)];
    const ownDone = receipt(own, "c3", frame(output, "completed", "j3", { cwd: SCRIPTS }));
    expect(ownDone.data).toHaveProperty("refused");
    expect(() => toolEvidence([...own, ownDone], "c3", CWD)).toThrow("coordinates");
  });
});
