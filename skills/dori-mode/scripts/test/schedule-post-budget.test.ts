import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deliverSchedule } from "../src/schedule-delivery.ts";
import { scheduleOutput } from "../src/schedule-store.ts";
import type { ScheduledJob, ScheduleRun } from "../src/schedule-types.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test.each(["post:discord:123456789", "post:telegram:-100123/42", "post:slack:C123"] as const)(
  "large output remains one bounded post with an intact log: %s",
  async (destination) => {
    const dir = mkdtempSync(join(tmpdir(), "dori-post-budget-"));
    dirs.push(dir);
    const receipt: ScheduleRun = {
      id: randomUUID(),
      at: 1000,
      startedAt: 1000,
      finishedAt: 2000,
      status: "exited",
      code: 0,
      delivery: "pending",
    };
    const job: ScheduledJob = {
      id: randomUUID(),
      name: "report",
      cron: "* * * * *",
      tz: "UTC",
      cwd: dir,
      argv: ["true"],
      deliver: destination,
      paused: false,
      nextAt: 60_000,
      missed: 0,
    };
    mkdirSync(join(dir, "schedule-runs"));
    const output = scheduleOutput(dir, receipt.id);
    const raw = "x".repeat(60_000);
    writeFileSync(output, raw);
    const bodies: { text?: string; content?: string }[] = [];
    const result = await deliverSchedule(
      dir,
      job,
      receipt,
      new AbortController().signal,
      () => {
        throw Error("must not wake");
      },
      async (request) => {
        bodies.push(JSON.parse(request.body as string));
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            destination.includes("discord")
              ? { id: "123456" }
              : destination.includes("telegram")
                ? { ok: true, result: { message_id: 12 } }
                : { ok: true, channel: "C123", ts: "1700.001" },
          ),
        };
      },
      { DORI_DISCORD_TOKEN: "fake", DORI_TELEGRAM_TOKEN: "fake", DORI_SLACK_TOKEN: "xoxb-fake" },
    );
    expect(result.delivery).toBe("posted");
    expect(bodies).toHaveLength(1);
    const text = bodies[0]!.text ?? bodies[0]!.content!;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain(output);
    expect(readFileSync(output, "utf8")).toBe(raw);
  },
);
