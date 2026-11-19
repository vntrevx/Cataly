import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { DeliveryUncertainError, fetchHttp, type Http } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { fakeClock } from "./fakes.ts";

test("a real 307 cannot forward upload bytes, while an unspecified fetch redirect keeps its existing default", async () => {
  const bytes = new Uint8Array([0, 1, 127, 255]);
  const received: { path: string; body: Uint8Array }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ path: request.url ?? "", body: Buffer.concat(chunks) });
    if (request.url === "/start") {
      response.writeHead(307, { Location: "/sink" });
      response.end();
    } else response.end("OK");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback address");
  const url = `http://127.0.0.1:${address.port}/start`;
  let tickets = 0;
  let uploads = 0;
  let completions = 0;
  const http: Http = async (request) => {
    if (request.url === "https://slack.com/api/files.getUploadURLExternal") {
      tickets++;
      return {
        status: 200,
        headers: {},
        body: '{"ok":true,"file_id":"F1","upload_url":"https://files.slack.com/upload/v1/1"}',
      };
    }
    if (request.url === "https://slack.com/api/files.completeUploadExternal") {
      completions++;
      return { status: 200, headers: {}, body: '{"ok":true,"files":[{"id":"F1"}]}' };
    }
    uploads++;
    return fetchHttp({ ...request, url });
  };
  try {
    const error = await new Slack(http, fakeClock(0), { token: "synthetic-token" })
      .upload("C1", "report.bin", bytes)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect(error).toMatchObject({ outcome: "uncertain" });
    expect({ tickets, uploads, completions }).toEqual({ tickets: 1, uploads: 1, completions: 0 });
    expect(received.map((request) => request.path)).toEqual(["/start"]);
    expect(received[0]?.body).toEqual(Buffer.from(bytes));

    const followed = await fetchHttp({ method: "POST", url, body: bytes });
    expect(followed.status).toBe(200);
    expect(received.map((request) => request.path)).toEqual(["/start", "/start", "/sink"]);
    expect(received[2]?.body).toEqual(Buffer.from(bytes));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
