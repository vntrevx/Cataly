import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { withState } from "./fakes.ts";

for (const page of ["has_more", "cursor"])
  test(`Slack cannot certify quiet while replies report ${page}`, async () => {
    const state = withState();
    try {
      const config = join(state.dir, "config.json");
      const activity = join(state.dir, "activity.json");
      writeFileSync(config, JSON.stringify({ stateDir: state.dir, runtime: "herdr", hooks: {} }));
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(import.meta.dir, "record-slack-activity-backlog.ts"),
          join(import.meta.dir, "../src/cli.ts"),
          "inbound",
          "slack",
          "--loop",
          "1",
          "--activity-file",
          activity,
        ],
        {
          env: {
            HOME: state.dir,
            PATH: "/usr/bin:/bin",
            DORI_CONFIG: config,
            DORI_STATE_DIR: state.dir,
            DORI_TEST_PAGE: page,
            DORI_TEST_ACTIVITY: activity,
            DORI_SLACK_TOKEN: "synthetic-slack-token",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).not.toContain("WARN");
      expect(out).not.toContain("INBOUND own-thread");
      const line = out.split("\n").find((line) => line.startsWith("SLACK_ACTIVITY_QA "))!;
      const record = JSON.parse(line.slice("SLACK_ACTIVITY_QA ".length));
      expect(Date.now() - record.quietSince).toBeGreaterThanOrEqual(1_800_000);
      expect(record.available).toBe(false);
      expect(await new ThreadLedger(join(state.dir, "slack-threads.json")).list()).toEqual([
        { channel: "C_WATCHED", rootTs: "1", seenTs: "51" },
      ]);
    } finally {
      state.done();
    }
  });
