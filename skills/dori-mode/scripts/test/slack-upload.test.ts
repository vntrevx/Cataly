import { expect, test } from "bun:test";
import {
  DeliveryUncertainError,
  type Http,
  type HttpRequest,
  type HttpResponse,
  MessengerError,
} from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { fakeClock } from "./fakes.ts";

const ticket = { file_id: "F1", upload_url: "https://files.slack.com/upload/v1/1?signature=synthetic-signature" };
const bytes = new Uint8Array([0, 1, 127, 255]);
const json = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const setup = (
  slot: Record<string, unknown> = ticket,
  completed: HttpResponse = json({ ok: true, files: [{ id: "F2" }, { id: "F1" }] }),
  putStatus = 200,
) => {
  const requests: HttpRequest[] = [];
  const http: Http = async (request) => {
    requests.push(request);
    if (request.url === "https://slack.com/api/files.getUploadURLExternal") return json({ ok: true, ...slot });
    if (request.url === "https://slack.com/api/files.completeUploadExternal") return completed;
    return { status: putStatus, headers: {}, body: "upload bytes response" };
  };
  return { requests, slack: new Slack(http, fakeClock(0), { token: "synthetic-token", cookie: "synthetic-cookie" }) };
};

test.each([
  { threadTs: undefined, title: undefined },
  { threadTs: "5.6", title: "Report" },
])("valid upload preserves the file ID, byte body, title, and thread: %p", async ({ threadTs, title }) => {
  const { requests, slack } = setup();
  expect(await slack.upload("C1", "report.bin", bytes, threadTs, title)).toBe("F1");
  expect(requests).toHaveLength(3);
  expect(JSON.parse(String(requests[0]?.body))).toEqual({ filename: "report.bin", length: bytes.byteLength });
  expect(requests[0]?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", Cookie: "d=synthetic-cookie" });
  expect(requests[1]).toMatchObject({ method: "POST", url: ticket.upload_url, redirect: "error" });
  expect(requests[1]?.body).toBe(bytes);
  expect(requests[1]?.headers).toBeUndefined();
  expect(JSON.parse(String(requests[2]?.body))).toEqual({
    files: [{ id: "F1", title: title ?? "report.bin" }],
    channel_id: "C1",
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
});

test.each(
  [
    undefined,
    null,
    42,
    {},
    "not a URL",
    "//files.slack.com/upload/v1/1",
    "http://files.slack.com/upload/v1/1",
    "ftp://files.slack.com/upload/v1/1",
    "https://evil.example/upload/v1/1?signature=synthetic-signature",
    "https://files.slack.com.evil.example/upload/v1/1",
    "https://files.slack.com:444/upload/v1/1",
    "https://user:synthetic-password@files.slack.com/upload/v1/1",
    "https://files.slack.com/not-upload/1",
    "https://files.slack.com/upload/v1",
    "https://files.slack.com/upload/v1/%2e%2e/%2e%2e/private",
  ].map((uploadUrl) => ({ uploadUrl })),
)("invalid upload URL cannot receive bytes: %p", async ({ uploadUrl }) => {
  const { requests, slack } = setup({ ...ticket, upload_url: uploadUrl });
  const error = await slack.upload("C1", "report.bin", bytes).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MessengerError);
  expect(error).toMatchObject({ outcome: "rejected" });
  expect(String(error)).not.toContain("synthetic-signature");
  expect(String(error)).not.toContain("synthetic-password");
  expect(requests).toHaveLength(1);
});

test.each(
  [undefined, null, 42, {}, "", "F", "C1", "f1", "F1?signature=synthetic-signature"].map((fileId) => ({ fileId })),
)("invalid file ID cannot receive bytes or reach completion: %p", async ({ fileId }) => {
  const { requests, slack } = setup({ ...ticket, file_id: fileId });
  const error = await slack.upload("C1", "report.bin", bytes).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MessengerError);
  expect(error).toMatchObject({ outcome: "rejected" });
  expect(String(error)).not.toContain("synthetic-signature");
  expect(requests).toHaveLength(1);
});

test("the default HTTPS port and normalized hostname remain valid without rewriting the signed URL", async () => {
  const uploadUrl = "https://FILES.SLACK.COM:443/upload/v1/1?signature=synthetic-signature";
  const { requests, slack } = setup({ ...ticket, upload_url: uploadUrl });
  expect(await slack.upload("C1", "report.bin", bytes)).toBe("F1");
  expect(requests[1]?.url).toBe(uploadUrl);
});

test.each(
  [undefined, null, [], [{ id: "F2" }], [null, 1, "F1"], [{ id: 1 }], { id: "F1" }].map((files) => ({ files })),
)("completion must identify the exact requested file before reporting success: %p", async ({ files }) => {
  const { requests, slack } = setup(ticket, json({ ok: true, files }));
  const error = await slack.upload("C1", "report.bin", bytes).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(DeliveryUncertainError);
  expect(error).toMatchObject({ outcome: "uncertain", receipt: undefined });
  expect(String(error)).toContain("do not resend");
  expect(requests).toHaveLength(3);
  expect(requests.filter((request) => request.body === bytes)).toHaveLength(1);
});

test.each([
  { status: 200, body: '{"ok":false,"error":"not_in_channel"}', outcome: "rejected" },
  { status: 403, body: '{"ok":false,"error":"missing_scope"}', outcome: "rejected" },
  { status: 503, body: "synthetic private server detail", outcome: "uncertain" },
  { status: 200, body: "{", outcome: "uncertain" },
])("failed or unknown completion never reuploads or reports publication: %p", async ({ status, body, outcome }) => {
  const { requests, slack } = setup(ticket, { status, headers: {}, body });
  const error = await slack.upload("C1", "report.bin", bytes).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MessengerError);
  expect(error).toMatchObject({ outcome });
  expect(requests).toHaveLength(3);
  expect(requests.filter((request) => request.body === bytes)).toHaveLength(1);
});

test.each([400, 503])("raw upload HTTP %s never reaches publication", async (status) => {
  const { requests, slack } = setup(ticket, json({ ok: true, files: [{ id: "F1" }] }), status);
  const error = await slack.upload("C1", "report.bin", bytes).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MessengerError);
  expect(error).toMatchObject({ status, outcome: status === 503 ? "uncertain" : "rejected" });
  expect(requests).toHaveLength(2);
});
