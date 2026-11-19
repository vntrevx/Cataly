import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { Discord } from "../src/messenger/discord.ts";
import { DeliveryUncertainError, fetchHttp, type HttpRequest, withBackoff } from "../src/messenger/http.ts";
import { fakeClock } from "./fakes.ts";

const canceledResponse = async (
  status: number,
  body: string,
  request: Pick<HttpRequest, "method" | "readOnly"> = { method: "POST" },
) => {
  const controller = new AbortController();
  const reason = new Error("owned postflight stop");
  let calls = 0;
  const outcome = await withBackoff(
    async () => {
      calls++;
      controller.abort(reason);
      return { status, headers: {}, body };
    },
    fakeClock(0),
    { ...request, url: "https://example.invalid/cancellation", signal: controller.signal },
  ).catch((error: unknown) => error);
  return { outcome, reason, calls };
};

for (const status of [200, 201, 204, 302, 408, 500, 503]) {
  test(`canceled mutation HTTP ${status} keeps uncertainty and only an available unconfirmed 2xx ID`, async () => {
    const { outcome, calls } = await canceledResponse(status, status === 204 ? "" : '{"id":"71"}');
    expect(outcome).toBeInstanceOf(DeliveryUncertainError);
    expect(outcome).toMatchObject({ status, code: "DELIVERY_UNCERTAIN", outcome: "uncertain", receipt: undefined });
    if (status === 200 || status === 201) expect(outcome).toHaveProperty("candidateReceipt", { id: "71" });
    else expect(outcome).not.toHaveProperty("candidateReceipt");
    expect(String(outcome)).toContain("do not resend");
    expect(calls).toBe(1);
  });
}

for (const body of ["", "{}", "null", "{", '{"id":""}', '{"id":71}', '["71"]']) {
  test(`canceled 2xx body without a nonempty string ID has no candidate: ${JSON.stringify(body)}`, async () => {
    const { outcome, calls } = await canceledResponse(200, body);
    expect(outcome).toBeInstanceOf(DeliveryUncertainError);
    expect(outcome).toMatchObject({ outcome: "uncertain", receipt: undefined });
    expect(outcome).not.toHaveProperty("candidateReceipt");
    expect(calls).toBe(1);
  });
}

for (const status of [400, 403, 429]) {
  test(`canceled rejected mutation HTTP ${status} preserves the original abort reason`, async () => {
    const { outcome, reason, calls } = await canceledResponse(status, '{"id":"71"}');
    expect(outcome).toBe(reason);
    expect(calls).toBe(1);
  });
}

for (const request of [{ method: "GET" }, { method: "POST", readOnly: true }] as const) {
  for (const status of [200, 503]) {
    test(`canceled read ${request.method} HTTP ${status} keeps the original reason`, async () => {
      const { outcome, reason, calls } = await canceledResponse(status, '{"id":"71"}', request);
      expect(outcome).toBe(reason);
      expect(calls).toBe(1);
    });
  }
}

for (const complete of [true, false]) {
  test(`real HTTP body completion=${complete} gates the unconfirmed candidate without replay`, async () => {
    const controller = new AbortController();
    const body = '{"id":"71"}';
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body) + (complete ? 0 : 32)),
      });
      response.write(body, () => {
        if (complete) response.end();
        else response.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing loopback address");
    try {
      const discord = new Discord(
        async (request) => {
          const result = await fetchHttp(request);
          controller.abort(new Error("owned after-body stop"));
          return result;
        },
        fakeClock(0),
        "synthetic-token",
        `http://127.0.0.1:${address.port}`,
      );
      const outcome = await discord
        .call("POST", "/channels/50/messages", { content: "one owned request" }, controller.signal)
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(DeliveryUncertainError);
      expect(outcome).toMatchObject({ outcome: "uncertain", receipt: undefined });
      if (complete) expect(outcome).toMatchObject({ status: 200, candidateReceipt: { id: "71" } });
      else expect(outcome).not.toHaveProperty("candidateReceipt");
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}
