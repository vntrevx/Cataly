import { expect, spyOn, test } from "bun:test";
import { Discord } from "../src/messenger/discord.ts";
import { type HttpResponse, withBackoff } from "../src/messenger/http.ts";

const noWait = {
  now: () => 0,
  sleep: async () => {
    throw new Error("unexpected retry sleep");
  },
};
const response = (status: number): HttpResponse => ({ status, headers: {}, body: "{}" });

for (const method of ["GET", "POST"] as const) {
  test(`${method} preflight cancellation preserves the reason without issuing HTTP`, async () => {
    const controller = new AbortController();
    const reason = new Error("owned preflight stop");
    controller.abort(reason);
    let calls = 0;
    const outcome = await withBackoff(
      async () => {
        calls++;
        return response(200);
      },
      noWait,
      { method, url: "https://example.invalid/cancellation", signal: controller.signal },
    ).catch((error: unknown) => error);
    expect(outcome).toBe(reason);
    expect(calls).toBe(0);
  });

  test(`${method} postflight cancellation preserves read identity or mutation uncertainty`, async () => {
    const controller = new AbortController();
    const reason = new Error("owned postflight stop");
    let calls = 0;
    const outcome = await withBackoff(
      async () => {
        calls++;
        controller.abort(reason);
        return response(200);
      },
      noWait,
      { method, url: "https://example.invalid/cancellation", signal: controller.signal },
    ).catch((error: unknown) => error);
    if (method === "GET") expect(outcome).toBe(reason);
    else expect(outcome).toMatchObject({ status: 200, code: "DELIVERY_UNCERTAIN", outcome: "uncertain" });
    expect(calls).toBe(1);
  });

  test(`${method} signaled 429 wait honors all Retry-After and removes its abort listener`, async () => {
    const controller = new AbortController();
    const reason = new Error("owned rate-limit stop");
    const entered = Promise.withResolvers<void>();
    const timer = spyOn(globalThis, "setTimeout");
    const clear = spyOn(globalThis, "clearTimeout");
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    let calls = 0;
    const outcome = withBackoff(
      async () => {
        calls++;
        entered.resolve();
        return { ...response(429), headers: { "retry-after": "60" } };
      },
      noWait,
      { method, url: "https://example.invalid/cancellation", signal: controller.signal },
      { attempts: 2, baseMs: 1, maxMs: 5 },
    ).catch((error: unknown) => error);
    try {
      await entered.promise;
      expect(timer.mock.calls).toHaveLength(1);
      expect(timer.mock.calls[0]?.[1]).toBe(60_000);
      expect(add.mock.calls).toHaveLength(1);
      controller.abort(reason);
      expect(await outcome).toBe(reason);
      expect(calls).toBe(1);
      expect(clear).toHaveBeenCalledWith(timer.mock.results[0]?.value);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    } finally {
      controller.abort(reason);
      await outcome;
      timer.mockRestore();
      clear.mockRestore();
      add.mockRestore();
      remove.mockRestore();
    }
  });
}

test("a signaled mutation transport failure remains uncertain and is never replayed", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic private transport detail");
  let calls = 0;
  const outcome = await withBackoff(
    async () => {
      calls++;
      controller.abort(reason);
      throw reason;
    },
    noWait,
    { method: "POST", url: "https://example.invalid/mutation", signal: controller.signal },
  ).catch((error: unknown) => error);
  expect(outcome).toMatchObject({ code: "DELIVERY_UNCERTAIN", outcome: "uncertain" });
  expect(String(outcome)).toContain("do not resend");
  expect(String(outcome)).not.toContain(reason.message);
  expect(calls).toBe(1);
});

for (const status of [408, 503]) {
  test(`signaled mutation HTTP ${status} preserves uncertainty without retry`, async () => {
    let calls = 0;
    const outcome = await withBackoff(
      async () => {
        calls++;
        return response(status);
      },
      noWait,
      { method: "POST", url: "https://example.invalid/mutation", signal: new AbortController().signal },
    ).catch((error: unknown) => error);
    expect(outcome).toMatchObject({ status, code: "DELIVERY_UNCERTAIN", outcome: "uncertain" });
    expect(calls).toBe(1);
  });
}

test("cancellable Discord metadata still owns one HTTP attempt outside generic read retries", async () => {
  let calls = 0;
  const discord = new Discord(
    async () => {
      calls++;
      return { ...response(429), headers: { "retry-after": "60" } };
    },
    noWait,
    "synthetic-token",
  );
  const outcome = await discord
    .call("GET", "/channels/50", undefined, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(outcome).toMatchObject({ status: 429 });
  expect(calls).toBe(1);
});
