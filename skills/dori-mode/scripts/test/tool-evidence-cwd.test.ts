import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EvidenceError } from "../src/evidence.ts";
import { hasDoriCommand } from "../src/monitor-command.ts";
import { toolEvidence } from "../src/tool-evidence.ts";

// Where a Bash call may have run after a directory change the reading cannot confirm. Evidence (the possible reading)
// must refuse a relative CLI in any directory the call may have run in; monitor ownership (the default reading) keeps
// its certainty. The scripts directory is where `bun src/cli.ts` is the Dori CLI; the repo root and a work directory
// are where it is not.
const SCRIPTS = join(import.meta.dir, "..");
const ROOT = join(SCRIPTS, "../../..");
const WORK = "/work/app";
const CHECKPOINT = "bun src/cli.ts checkpoint lane --step s1 --result ok --evidence proof";

// One completed, successful Bash call of `command` whose output looks like a checkpoint.
const bash = (command: string) => [
  {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }] },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: '{"checkpoint":{"step":"s1","result":"ok"}}' }],
      isError: false,
      timestamp: 1,
    },
  },
];
const refuses = (command: string, cwd: string | undefined, reason: string) => {
  expect(() => toolEvidence(bash(command), "c1", cwd)).toThrow(reason);
  expect(() => toolEvidence(bash(command), "c1", cwd)).toThrow(EvidenceError);
};
const accepts = (command: string, cwd: string) => expect(toolEvidence(bash(command), "c1", cwd).kind).toBe("tool");

describe("a cd that may fail keeps the directory the call ran in", () => {
  test.each([
    `bash -c 'cd /nonexistent; ${CHECKPOINT}'`,
    `cd /nonexistent; ${CHECKPOINT}`,
    `cd /nonexistent || true; ${CHECKPOINT}`,
    // The first `cd` may fail, so the `||` may run where the chain began, not only where either `cd` led.
    `cd /nonexistent && cd app || ${CHECKPOINT}`,
  ])("%s may run the CLI where it started", (command) => {
    expect(hasDoriCommand(command, SCRIPTS)).toBe(false);
    expect(hasDoriCommand(command, SCRIPTS, true)).toBe(true);
    refuses(command, SCRIPTS, "coordinates");
  });

  test("the commands an && joins to a cd run only where it moved", () => {
    const moved = `cd /nonexistent && ${CHECKPOINT}`;
    expect(hasDoriCommand(moved, SCRIPTS, true)).toBe(false);
    accepts(moved, SCRIPTS);
    const into = `cd skills/dori-mode/scripts && ${CHECKPOINT}`;
    expect(hasDoriCommand(into, ROOT)).toBe(true);
    refuses(into, ROOT, "coordinates");
  });

  test("the default reading still takes a cd that starts a list as moved", () => {
    const command = `cd ${SCRIPTS}; ${CHECKPOINT}`;
    expect(hasDoriCommand(command, "/other")).toBe(true);
    expect(hasDoriCommand(`cd /other; ${CHECKPOINT}`, SCRIPTS)).toBe(false);
    refuses(command, "/other", "coordinates");
  });
});

describe("a directory the reading cannot know", () => {
  test.each([
    `pushd skills/dori-mode/scripts && ${CHECKPOINT}`,
    `pushd skills/dori-mode/scripts >/dev/null; ${CHECKPOINT}`,
    `popd && ${CHECKPOINT}`,
    `cd "$SKILL" && ${CHECKPOINT}`,
    `cd $(dirname "$0") && ${CHECKPOINT}`,
    `cd; ${CHECKPOINT}`,
    `cd ~/skill && ${CHECKPOINT}`,
    `cd skills/*/scripts && ${CHECKPOINT}`,
    `env -C "$SKILL" ${CHECKPOINT}`,
    `bun --cwd "$SKILL" src/cli.ts checkpoint lane --step s1 --result ok`,
    `bun "$SKILL/src/cli.ts" checkpoint lane --step s1 --result ok`,
  ])("%s may run the CLI", (command) => {
    expect(hasDoriCommand(command, ROOT)).toBe(false);
    expect(hasDoriCommand(command, ROOT, true)).toBe(true);
    refuses(command, ROOT, "coordinates");
  });

  test("a call whose start this process did not see is still refused as unseen", () => {
    refuses(`cd "$SKILL" && ${CHECKPOINT}`, undefined, "did not see");
    refuses(`pushd skills/dori-mode/scripts && ${CHECKPOINT}`, undefined, "did not see");
  });

  test("directories that may pile up past the bound read as unknown, and only a relative CLI is refused there", () => {
    const cds = Array.from({ length: 24 }, (_, i) => `cd d${i};`).join(" ");
    refuses(`${cds} bun src/cli.ts test`, WORK, "coordinates");
    accepts(`${cds} bun test`, WORK);
    accepts("cd a; cd b; bun src/cli.ts test", WORK);
  });
});

describe("clear work and quoted data stay work", () => {
  test.each([
    ["cd app; bun src/cli.ts test", WORK],
    ["cd /tmp && bun src/cli.ts test", SCRIPTS],
    ["pushd build && make; popd", WORK],
    ['cd "$OUT" && make', WORK],
    [`printf '%s\\n' 'cd /nonexistent; ${CHECKPOINT}' > docs/usage.md`, SCRIPTS],
    [`rg -F 'pushd "$SKILL" && ${CHECKPOINT}' docs`, SCRIPTS],
    [`echo "cd; ${CHECKPOINT}"`, SCRIPTS],
  ])("%s in %s", (command, cwd) => {
    expect(hasDoriCommand(command, cwd, true)).toBe(false);
    accepts(command, cwd);
  });
});
