import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Backlog } from "../core/backlog.js";
import { collectBootSummary, formatBootMarkdown } from "../core/boot.js";
import { Checkpoints } from "../core/checkpoints.js";
import { resolveStateDir, updateConfig } from "../core/config.js";
import { Decisions } from "../core/decisions.js";
import { LaneRegistry } from "../core/lanes.js";
import { Lessons } from "../core/lessons.js";
import { SharedLocks } from "../core/locks.js";
import { Reports } from "../core/reports.js";
import { checkDone, doneSyntaxErrors, parseSignal, type Runner } from "../core/signals.js";
import { Worklog } from "../core/worklog.js";

const tempDirs: string[] = [];
function makeTempDir(prefix = "cataly-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("signals", () => {
  it("parses and validates all Done = signal types", () => {
    assert.deepEqual(doneSyntaxErrors("merged acme/app#42; closed acme/app#10; published foo@1.2.3"), []);
    assert.deepEqual(
      doneSyntaxErrors(
        'command ["node","-e","console.log(123)"] stdout~"123"; file out.json json:.ok=true; url https://example.com status=200 body~"ok"',
      ),
      [],
    );
    assert.ok(doneSyntaxErrors("just trust me").length > 0);
    assert.equal(parseSignal("merged acme/app#12").kind, "merged");
  });

  it("verifies file (sha256 + json), command, url, and mocked gh/npm signals live", async () => {
    const dir = makeTempDir();
    const jsonFile = join(dir, "report.json");
    const content = JSON.stringify({ passed: true, count: 3 });
    writeFileSync(jsonFile, content);
    const sha = createHash("sha256").update(content).digest("hex");

    const fakeRunner: Runner = async (argv) => {
      if (argv[0] === "gh" && argv[1] === "pr") {
        return { code: 0, out: JSON.stringify({ state: "MERGED", mergeCommit: { oid: "abc1234567890" } }), err: "" };
      }
      if (argv[0] === "npm" && argv[1] === "view") {
        return { code: 0, out: JSON.stringify(["1.0.0"]), err: "" };
      }
      if (argv[0] === "ok-cmd") {
        return { code: 0, out: "all 5 passed", err: "" };
      }
      return { code: 1, out: "", err: "failed" };
    };

    const doneLine = [
      `file report.json sha256=${sha} json:.passed=true`,
      `command ["ok-cmd"] stdout~"5 passed"`,
      `merged acme/app#7`,
      `published mypkg@1.0.0`,
      `url https://health.local status=200 body~"ready"`,
    ].join("; ");

    const checks = await checkDone(doneLine, fakeRunner, {
      cwd: dir,
      http: async () => ({ status: 200, body: "service ready" }),
    });
    assert.equal(checks.length, 5);
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks),
    );

    const failChecks = await checkDone("file report.json json:.count=99", fakeRunner, { cwd: dir });
    assert.equal(failChecks[0]?.ok, false);
  });
});

describe("lanes, lessons, checkpoints, reports, sweep", () => {
  it("creates lane with injected lessons, enforces Done verification, and handles sweep", async () => {
    const home = makeTempDir("cataly-home-");
    const workDir = makeTempDir("cataly-repo-");
    const stateDir = resolveStateDir(home);
    updateConfig({ doneGraceMinutes: 5, staleMinutes: 10 }, home);

    const lessons = new Lessons(stateDir);
    lessons.add({ lane: "seed-lane", scope: "global", rule: "Never skip tests", evidence: "incident-1" });
    lessons.add({ lane: "seed-lane", cwd: workDir, rule: "Run tsc before build", evidence: "incident-2" });

    const targetFile = join(workDir, "artifact.json");
    const registry = new LaneRegistry(stateDir, home);
    const created = registry.create({
      key: "ship-feature",
      title: "Ship feature X",
      cwd: workDir,
      done: "file artifact.json json:.ready=true",
      briefBody: "Implement feature X cleanly.",
      priority: 2,
    });

    assert.match(created.renderedBrief, /Never skip tests/);
    assert.match(created.renderedBrief, /Run tsc before build/);
    assert.match(created.renderedBrief, /Done =/);

    const attached = registry.attach("ship-feature", "conv-123", "cataly-lane");
    assert.equal(attached.conversationId, "conv-123");

    const reports = new Reports(stateDir);
    reports.report("ship-feature", "milestone", "Implemented core handler");
    assert.equal(reports.readProgress("ship-feature")?.state, "running");

    const checkpoints = new Checkpoints(stateDir);
    const cp1 = checkpoints.write("ship-feature", {
      step: "open-pr",
      result: "PR #12 opened",
      evidence: ["https://github.com/acme/repo/pull/12"],
      remoteEffects: ["github:pr:12"],
    });
    assert.equal(cp1.unchanged, false);
    const cp1Dup = checkpoints.write("ship-feature", {
      step: "open-pr",
      result: "PR #12 opened",
      evidence: ["https://github.com/acme/repo/pull/12"],
      remoteEffects: ["github:pr:12"],
    });
    assert.equal(cp1Dup.unchanged, true);
    assert.throws(() =>
      checkpoints.write("ship-feature", {
        step: "another-step",
        result: "duplicate effect",
        evidence: [],
        remoteEffects: ["github:pr:12"],
      }),
    );

    // Claim done BEFORE artifact exists -> verifyAndClose must reject back to not-done
    const t0 = Date.now();
    registry.claimDone("ship-feature", "claimed early", 5, undefined, t0);
    const failedVerify = await registry.verifyAndClose("ship-feature", { skipGitCheck: true, now: t0 + 1000 });
    assert.equal(failedVerify.closed, false);
    assert.equal(failedVerify.lane.status, "not-done");

    // Optimistic version check
    assert.throws(() => registry.pause("ship-feature", "hold", 1), /LANE_CHANGED/);

    // Now write artifact and claim done -> sweep after 6 minutes auto-verifies and closes
    writeFileSync(targetFile, JSON.stringify({ ready: true }));
    registry.claimDone("ship-feature", "artifact.json written", 5, undefined, t0 + 2000);
    const swept = await registry.sweep({ skipGitCheck: true, now: t0 + 10 * 60_000 });
    assert.deepEqual(swept.closed, ["ship-feature"]);
    assert.equal(registry.require("ship-feature").status, "closed");
  });

  it("does not overwrite a concurrent objectDone when verifyAndClose finishes after a version change", async () => {
    const home = makeTempDir("cataly-home-");
    const workDir = makeTempDir("cataly-repo-");
    const stateDir = resolveStateDir(home);
    updateConfig({ doneGraceMinutes: 1 }, home);

    const registry = new LaneRegistry(stateDir, home);
    registry.create({
      key: "race-lane",
      title: "Race guard lane",
      cwd: workDir,
      done: 'command ["verify-cmd"] stdout~"passed"',
      briefBody: "Verify version guard under concurrent objection.",
    });

    const t0 = Date.now();
    registry.claimDone("race-lane", "claim before verification", 1, undefined, t0);

    let enteredVerifier!: () => void;
    const verifierStarted = new Promise<void>((r) => {
      enteredVerifier = r;
    });
    let releaseVerifier!: () => void;
    const verifierGate = new Promise<void>((r) => {
      releaseVerifier = r;
    });

    const pausedRunner: Runner = async () => {
      enteredVerifier();
      await verifierGate;
      return { code: 0, out: "all tests passed", err: "" };
    };

    const verifyPromise = registry.verifyAndClose("race-lane", {
      skipGitCheck: true,
      runner: pausedRunner,
      now: t0 + 2000,
    });

    // Wait until the verifier is mid-flight, then record a lead objection
    await verifierStarted;
    const objected = registry.objectDone("race-lane", "lead found missing edge-case test", undefined, t0 + 1000);
    assert.equal(objected.status, "not-done");

    // Let the in-flight verification succeed and complete
    releaseVerifier();
    const res = await verifyPromise;

    assert.equal(res.closed, false);
    assert.equal(res.lane.status, "not-done");
    assert.equal(res.lane.version, objected.version);
    assert.equal(res.lane.objection?.reason, "lead found missing edge-case test");
    assert.ok(
      res.reasons.some((r) => r.includes("changed concurrently")),
      `expected concurrent change reason, got ${JSON.stringify(res.reasons)}`,
    );

    const stored = registry.require("race-lane");
    assert.equal(stored.status, "not-done");
    assert.equal(stored.objection?.reason, "lead found missing edge-case test");
  });

  it("handles concurrent objectDone cleanly inside sweep without closing or throwing", async () => {
    const home = makeTempDir("cataly-home-");
    const workDir = makeTempDir("cataly-repo-");
    const stateDir = resolveStateDir(home);
    updateConfig({ doneGraceMinutes: 1 }, home);

    const registry = new LaneRegistry(stateDir, home);
    registry.create({
      key: "sweep-race",
      title: "Sweep race guard lane",
      cwd: workDir,
      done: 'command ["verify-cmd"] stdout~"ok"',
      briefBody: "Ensure sweep survives concurrent objection.",
    });

    const t0 = Date.now();
    registry.claimDone("sweep-race", "claimed", 1, undefined, t0);

    let enteredSweepVerify!: () => void;
    const sweepStarted = new Promise<void>((r) => {
      enteredSweepVerify = r;
    });
    let releaseSweepVerify!: () => void;
    const sweepGate = new Promise<void>((r) => {
      releaseSweepVerify = r;
    });

    const pausedRunner: Runner = async () => {
      enteredSweepVerify();
      await sweepGate;
      return { code: 0, out: "ok", err: "" };
    };

    const sweepPromise = registry.sweep({
      skipGitCheck: true,
      runner: pausedRunner,
      now: t0 + 5 * 60_000,
    });

    await sweepStarted;
    registry.objectDone("sweep-race", "lead objected mid-sweep", undefined, t0 + 2 * 60_000);
    releaseSweepVerify();

    const swept = await sweepPromise;
    assert.deepEqual(swept.closed, []);
    assert.equal(swept.rejected.length, 1);
    assert.equal(swept.rejected[0]?.key, "sweep-race");
    assert.ok(swept.rejected[0]?.reasons.some((r) => r.includes("changed concurrently")));
    assert.equal(registry.require("sweep-race").status, "not-done");
  });

  it("guards later lanes in multi-lane sweep against concurrent objectDone and refuses to close paused lanes without forceClose", async () => {
    const home = makeTempDir("cataly-home-");
    const workDir = makeTempDir("cataly-repo-");
    const stateDir = resolveStateDir(home);
    updateConfig({ doneGraceMinutes: 1 }, home);

    const registry = new LaneRegistry(stateDir, home);
    registry.create({
      key: "lane-a",
      title: "First swept lane",
      cwd: workDir,
      done: 'command ["verify-a"] stdout~"ok"',
      briefBody: "Lane A",
      priority: 1,
    });
    registry.create({
      key: "lane-b",
      title: "Second swept lane",
      cwd: workDir,
      done: 'command ["verify-b"] stdout~"ok"',
      briefBody: "Lane B",
      priority: 2,
    });
    registry.create({
      key: "paused-lane",
      title: "Paused lane",
      cwd: workDir,
      done: 'command ["verify-p"] stdout~"ok"',
      briefBody: "Paused",
      priority: 3,
    });

    const t0 = Date.now();
    registry.claimDone("lane-a", "done A", 1, undefined, t0);
    registry.claimDone("lane-b", "done B", 1, undefined, t0);
    registry.pause("paused-lane", "waiting on owner", undefined, t0);

    // Refuses to close paused lane unless forceClose is set
    const pausedRes = await registry.verifyAndClose("paused-lane", {
      skipGitCheck: true,
      runner: async () => ({ code: 0, out: "ok", err: "" }),
      now: t0 + 1000,
    });
    assert.equal(pausedRes.closed, false);
    assert.equal(pausedRes.lane.status, "paused");
    assert.ok(pausedRes.reasons.some((r) => r.includes("paused")));

    let enteredLaneA!: () => void;
    const laneAStarted = new Promise<void>((r) => {
      enteredLaneA = r;
    });
    let releaseLaneA!: () => void;
    const laneAGate = new Promise<void>((r) => {
      releaseLaneA = r;
    });

    const executedCmds: string[] = [];
    const runner: Runner = async (argv) => {
      executedCmds.push(argv[0] ?? "");
      if (argv[0] === "verify-a") {
        enteredLaneA();
        await laneAGate;
      }
      return { code: 0, out: "ok", err: "" };
    };

    const sweepPromise = registry.sweep({
      skipGitCheck: true,
      runner,
      now: t0 + 5 * 60_000,
    });

    // While sweep is blocked verifying lane-a, object to lane-b
    await laneAStarted;
    registry.objectDone("lane-b", "objected while lane-a verified", undefined, t0 + 2 * 60_000);
    releaseLaneA();

    const swept = await sweepPromise;
    assert.deepEqual(swept.closed, ["lane-a"]);
    assert.equal(swept.rejected.length, 1);
    assert.equal(swept.rejected[0]?.key, "lane-b");
    assert.ok(swept.rejected[0]?.reasons.some((r) => r.includes("changed concurrently")));
    assert.equal(registry.require("lane-b").status, "not-done");
    assert.equal(registry.require("lane-b").objection?.reason, "objected while lane-a verified");
    assert.deepEqual(executedCmds, ["verify-a"]);
  });
});

describe("worklog, decisions, backlog, locks, boot", () => {
  it("tracks full owner lifecycle and compiles boot summary", () => {
    const home = makeTempDir("cataly-home-");
    const stateDir = resolveStateDir(home);

    const wl = new Worklog(stateDir);
    const item = wl.add("Build Cataly plugin", "antigravity");
    wl.next(item.id, "Implement MCP tools");
    wl.note(item.id, "Core modules finished");
    assert.equal(wl.open().length, 1);

    const dec = new Decisions(stateDir);
    const d = dec.ask({
      question: "Include Discord integration?",
      source: "antigravity",
      options: ["Yes", "No"],
      recommend: 1,
      worklog: item.id,
    });
    dec.posted(d.id, "discord:111/222");
    assert.equal(dec.match("discord:111/222")?.id, d.id);
    assert.match(dec.digest(), /Include Discord integration/);

    const backlog = new Backlog(stateDir);
    backlog.add({
      id: "task-a",
      title: "Task A",
      cwd: home,
      done: "file done.txt",
      brief: "Do task A",
      priority: 1,
      decision: "Need target region",
    });
    assert.equal(backlog.nextEligible().length, 0);
    backlog.decide("task-a", "Use us-central1");
    assert.equal(backlog.nextEligible().length, 1);

    const locks = new SharedLocks(stateDir);
    locks.acquire("build", "ship-feature", 1, "compiling");
    assert.equal(locks.list().length, 1);

    const summary = collectBootSummary(home);
    assert.equal(summary.openWorklog.length, 1);
    assert.equal(summary.openDecisions.length, 1);
    assert.equal(summary.backlogOpenCount, 1);
    assert.equal(summary.activeLocks.length, 1);
    assert.match(formatBootMarkdown(summary), /CATALY BOOT/);

    locks.release("build", "ship-feature");
    dec.answer(d.id, "Yes, include Discord", "antigravity", 1);
    wl.close(item.id, "Built and tested");
    assert.equal(wl.open().length, 0);
    assert.equal(dec.open().length, 0);
  });
});
