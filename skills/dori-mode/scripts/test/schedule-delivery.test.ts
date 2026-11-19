import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchHttp, type Http, type HttpRequest } from "../src/messenger/http.ts";
import { deliverSchedule } from "../src/schedule-delivery.ts";
import { scheduleOutput } from "../src/schedule-store.ts";
import type { ScheduledJob, ScheduleRun } from "../src/schedule-types.ts";
let dir: string;
let receipt: ScheduleRun;
let job: ScheduledJob;
const env = { DORI_DISCORD_TOKEN: "fake-discord", DORI_TELEGRAM_TOKEN: "fake-telegram", DORI_SLACK_TOKEN: "xoxb-fake" };
const reply = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dori-schedule-post-"));
  receipt = {
    id: randomUUID(),
    at: 1_000,
    startedAt: 1_000,
    finishedAt: 2_000,
    status: "exited",
    code: 0,
    delivery: "pending",
  };
  job = {
    id: randomUUID(),
    name: "report",
    cron: "* * * * *",
    tz: "UTC",
    argv: ["true"],
    cwd: dir,
    deliver: "post:discord:123456789",
    paused: false,
    nextAt: 60_000,
    missed: 0,
    last: receipt,
  };
  mkdirSync(join(dir, "schedule-runs"));
  writeFileSync(scheduleOutput(dir, receipt.id), "finished\n", { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const deliver = (
  http: Http,
  signal = new AbortController().signal,
  emit: (line: string) => unknown = () => {
    throw Error("unexpected wake");
  },
) => deliverSchedule(dir, job, receipt, signal, emit, http, env);

test("Discord uses the real HTTP adapter, suppresses mentions and records the returned ID", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      return Response.json({ id: "987654321" });
    },
  });
  try {
    const result = await deliver((request) =>
      fetchHttp({ ...request, url: "http://127.0.0.1:" + server.port + new URL(request.url).pathname }),
    );
    expect(result).toEqual({ delivery: "posted", receipts: ["987654321"] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/api/v10/channels/123456789/messages",
      body: { allowed_mentions: { parse: [] } },
    });
  } finally {
    server.stop(true);
  }
});

test.each([429, 500, 503])("an uncertain %s result is never retried", async (status) => {
  let calls = 0;
  await expect(
    deliver(async () => {
      calls++;
      return reply({ error: "unknown" }, status);
    }),
  ).rejects.toThrow("not retried");
  expect(calls).toBe(1);
});

test("an oversized report sends one log reference and never retries an uncertain result", async () => {
  writeFileSync(scheduleOutput(dir, receipt.id), "x".repeat(6000));
  const requests: HttpRequest[] = [];
  await expect(
    deliver(async (request) => {
      requests.push(request);
      return reply({}, 500);
    }),
  ).rejects.toThrow("not retried");
  expect(requests).toHaveLength(1);
  const text = JSON.parse(requests[0]!.body as string).content;
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).toContain(scheduleOutput(dir, receipt.id));
});

test("Telegram topic and Slack thread targeting use the established clients", async () => {
  const requests: HttpRequest[] = [];
  job.deliver = "post:telegram:-100123/42";
  expect(
    await deliver(async (request) => {
      requests.push(request);
      return reply({ ok: true, result: { message_id: 12 } });
    }),
  ).toEqual({ delivery: "posted", receipts: ["12"] });
  expect(JSON.parse(requests[0]!.body as string)).toMatchObject({ chat_id: "-100123", message_thread_id: 42 });
  job.deliver = "post:slack:C123/1700.001";
  expect(
    await deliver(async (request) => {
      requests.push(request);
      return reply({ ok: true, channel: "C123", ts: "1700.002" });
    }),
  ).toEqual({ delivery: "posted", receipts: ["C123/1700.002"] });
  expect(JSON.parse(requests[1]!.body as string)).toMatchObject({ channel: "C123", thread_ts: "1700.001" });
});

test("cancellation aborts a real in-flight HTTP request and starts no second request", async () => {
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      started();
      return response;
    },
  });
  const stopped = new AbortController();
  let calls = 0;
  try {
    const pending = deliver((request) => {
      calls++;
      return fetchHttp({ ...request, url: "http://127.0.0.1:" + server.port + "/" });
    }, stopped.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await received;
    stopped.abort(new Error("stop requested"));
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("stop requested");
    expect(calls).toBe(1);
  } finally {
    finish(Response.json({ id: "123456" }));
    server.stop(true);
  }
});

test("malformed success acknowledgements and pre-cancelled posts do not claim delivery", async () => {
  await expect(deliver(async () => reply({}))).rejects.toThrow("acknowledgement");
  let calls = 0;
  await expect(
    deliver(
      async () => {
        calls++;
        return reply({ id: "123456" });
      },
      AbortSignal.abort(new Error("already stopped")),
    ),
  ).rejects.toThrow("already stopped");
  expect(calls).toBe(0);
});

test.each([undefined, 0, "12"])("Telegram acknowledgement must be a positive integer: %s", async (messageId) => {
  job.deliver = "post:telegram:-100123/42";
  await expect(deliver(async () => reply({ ok: true, result: { message_id: messageId } }))).rejects.toThrow();
});

test("log never calls HTTP or wakes; a failed wake remains unconfirmed", async () => {
  job.deliver = "log";
  const never: Http = async () => {
    throw Error("unexpected HTTP");
  };
  expect(await deliver(never)).toEqual({ delivery: "logged" });
  job.deliver = "wake";
  await expect(
    deliver(never, new AbortController().signal, () => {
      throw Error("stdout closed");
    }),
  ).rejects.toThrow("stdout closed");
});
