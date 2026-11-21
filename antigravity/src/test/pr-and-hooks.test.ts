import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../core/config.js";
import { LaneRegistry } from "../core/lanes.js";
import { checkPrSnapshot, PrTracker } from "../core/pr.js";
import { Worklog } from "../core/worklog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..");

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cataly-hook-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function runNodeScript(scriptPath: string, stdinText: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`exit ${code}: ${err}`));
      else resolvePromise(out.trim());
    });
    child.stdin.end(stdinText);
  });
}

describe("PR verification and tracking", () => {
  it("enforces commit identity and test requirement on fix commits", () => {
    const baseCommit = {
      sha: "1111111",
      commit: {
        message: "fix: handle empty token",
        author: { name: "Dev", email: "dev@example.com" },
        committer: { name: "Dev", email: "dev@example.com" },
      },
      files: [{ filename: "src/auth.ts", status: "modified" }],
    };

    const fail = checkPrSnapshot(
      {
        repo: "acme/app",
        number: 5,
        body: "fixes bug",
        head: "1111111",
        commits: [baseCommit],
        files: baseCommit.files,
      },
      { name: "Dev", email: "dev@example.com" },
    );
    assert.equal(fail.ok, false);
    assert.ok(fail.errors.some((e) => e.includes("No test")));

    const passWithReason = checkPrSnapshot(
      {
        repo: "acme/app",
        number: 5,
        body: "fixes bug\nNo test: config-only guard verified manually",
        head: "1111111",
        commits: [baseCommit],
        files: baseCommit.files,
      },
      { name: "Dev", email: "dev@example.com" },
    );
    assert.equal(passWithReason.ok, true);
    assert.equal(passWithReason.warnings.length >= 1, true);
  });

  it("tracks PR state transitions via mocked gh runner", async () => {
    const home = makeTempDir();
    const tracker = new PrTracker(resolveStateDir(home));
    tracker.track("acme/app", 12, "fix-auth", "discord:123");

    const first = await tracker.checkUpdates(async () => ({
      code: 0,
      out: JSON.stringify({
        state: "OPEN",
        headRefOid: "aaaa1111",
        reviews: [],
        comments: [],
        statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
      }),
      err: "",
    }));
    assert.equal(first.events.length, 0);

    const second = await tracker.checkUpdates(async () => ({
      code: 0,
      out: JSON.stringify({
        state: "MERGED",
        headRefOid: "bbbb2222",
        reviews: [{ author: { login: "alice" }, state: "APPROVED" }],
        comments: [{ id: "1" }],
        statusCheckRollup: [],
      }),
      err: "",
    }));
    const kinds = second.events.map((e) => e.kind);
    assert.ok(kinds.includes("MERGED"));
    assert.ok(kinds.includes("NEW_COMMITS"));
    assert.ok(kinds.includes("NEW_REVIEWS"));
    assert.equal(tracker.list().length, 0); // auto-untracked after merge
  });
});

describe("Antigravity lifecycle hooks", () => {
  it("stays silent on empty SessionStart, injects boot summary when active, and guards working lanes once on Stop", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const hookScript = join(distDir, "hooks.js");

    // 1. Empty state -> {}
    const emptyOut = await runNodeScript(hookScript, JSON.stringify({ hookEventName: "SessionStart" }), {
      CATALY_HOME: home,
    });
    assert.deepEqual(JSON.parse(emptyOut), {});

    // 2. Active worklog + lane -> SessionStart injects systemMessage
    const wl = new Worklog(stateDir);
    wl.add("Fix CI flakiness", "antigravity");
    const lanes = new LaneRegistry(stateDir, home);
    lanes.create({
      key: "fix-ci",
      title: "Fix CI",
      cwd: home,
      done: "file ok.txt",
      briefBody: "Fix CI",
      conversationId: "conv-lane-99",
    });

    const startOut = JSON.parse(
      await runNodeScript(hookScript, JSON.stringify({ hookEventName: "SessionStart" }), { CATALY_HOME: home }),
    ) as { injectSteps?: { systemMessage?: { systemMessage?: string } }[] };
    assert.match(startOut.injectSteps?.[0]?.systemMessage?.systemMessage ?? "", /Fix CI flakiness/);

    // 3. Stop hook on unrelated conversation -> {}
    const stopOther = JSON.parse(
      await runNodeScript(
        hookScript,
        JSON.stringify({
          hookEventName: "Stop",
          conversationId: "conv-other",
          terminationReason: "NO_TOOL_CALL",
          continuationActive: false,
        }),
        { CATALY_HOME: home },
      ),
    );
    assert.deepEqual(stopOther, {});

    // 4. Stop hook on lane's own conversation -> continue once
    const stopOwn = JSON.parse(
      await runNodeScript(
        hookScript,
        JSON.stringify({
          hookEventName: "Stop",
          conversationId: "conv-lane-99",
          terminationReason: "NO_TOOL_CALL",
          continuationActive: false,
        }),
        { CATALY_HOME: home },
      ),
    ) as { decision?: string; reason?: string };
    assert.equal(stopOwn.decision, "continue");
    assert.match(stopOwn.reason ?? "", /fix-ci/);

    // 5. Stop hook with continuationActive: true -> does NOT loop
    const stopLoop = JSON.parse(
      await runNodeScript(
        hookScript,
        JSON.stringify({
          hookEventName: "Stop",
          conversationId: "conv-lane-99",
          terminationReason: "NO_TOOL_CALL",
          continuationActive: true,
        }),
        { CATALY_HOME: home },
      ),
    );
    assert.deepEqual(stopLoop, {});
  });
});
