import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import type { Lane } from "../src/registry.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { withState } from "./fakes.ts";

export const USAGE_ID = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
export const USAGE_NOW = Date.parse("2026-01-01T13:00:00Z");
export const usageEntry = (id: string, at: string, cost = 1, type = "message", cacheWrite = 0) => ({
  type,
  id,
  parentId: null,
  timestamp: at,
  ...(type === "model_usage"
    ? { purpose: "title", usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite, cost: { total: cost } } }
    : {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PRIVATE_TRANSCRIPT_CONTENT" }],
          usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite, cost: { total: cost } },
        },
      }),
});
export const writeUsageSession = (
  file: string,
  id: string,
  timestamp: string,
  entries: readonly unknown[],
  extra: Record<string, unknown> = {},
) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${[
      { type: "title", title: "PRIVATE_TITLE", v: 1 },
      { type: "session", id, timestamp, cwd: "/fixture", ...extra },
      ...entries,
    ]
      .map((e) => JSON.stringify(e))
      .join("\n")}\n`,
  );
};
export const usageFixture = () => {
  const state = withState();
  const config = {
    ...defaultConfig(state.dir),
    stateDir: join(state.dir, "state"),
    sessionsDir: join(state.dir, "sessions"),
    defaultCwd: state.dir,
  };
  const directory = sessionDirFor(config.sessionsDir, state.dir);
  const root = join(directory, `2026-01-01T12-00-00-000Z_${USAGE_ID}.jsonl`);
  const lane: Lane = {
    key: "usage-demo",
    title: "Usage",
    thread: "discord:40",
    session: USAGE_ID,
    openedAt: "2026-01-01T12:10:00Z",
    cwd: state.dir,
    brief: "/brief",
    done: "file /done",
    reportProtocol: "jsonl-v1",
  };
  writeUsageSession(root, USAGE_ID, "2026-01-01T12:00:00Z", [
    usageEntry("old", "2026-01-01T12:05:00Z", 50),
    usageEntry("new", "2026-01-01T12:20:00Z", 1),
    usageEntry("title", "2026-01-01T12:21:00Z", 2, "model_usage"),
  ]);
  return { ...state, config, directory, root, lane };
};
