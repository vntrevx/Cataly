import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { headReceipt } from "../extension/head-receipt.ts";
import type { HeadReply, HeadRequest } from "../skills/dori-mode/scripts/src/messenger/head-admission.ts";
import { openOwes } from "../skills/dori-mode/scripts/src/owes.ts";
import { withNativeIngress } from "./native-ingress-setup.ts";

const admissions = (entries: readonly unknown[]) =>
  entries.flatMap((raw) => {
    const entry = raw as {
      type: string;
      id: string;
      customType?: string;
      details?: { ompDoriAdmission?: { identity: string; fingerprint: string } };
    };
    const receipt = entry.details?.ompDoriAdmission;
    return entry.type === "custom_message" && entry.customType === "dori-monitor" && receipt
      ? [{ id: entry.id, ...receipt }]
      : [];
  });

test("actual native CLI: absent head retains cursor; ordered durable receipts survive repeated intake", async () => {
  await withNativeIngress(async (f) => {
    f.seed(["101", "102"]);
    const absent = await f.absent();
    expect(absent.code).not.toBe(0);
    expect(absent.err).toContain("head admission");
    expect(f.queued()).toMatchObject({ cursor: "100", unresolved: null });
    expect(f.server.requests).toHaveLength(0);

    const { head, file } = await f.start();
    expect((await head.client.getState()).model).toMatchObject({ provider: "ingress-local", id: "ingress-fixture" });
    await f.monitor(head, "start");
    expect(await f.intakeEnded()).toMatchObject({ code: 0 });
    expect(f.queued()).toEqual({ cursor: "102", pending: null, unresolved: null });
    const disk = admissions(f.server.entries());
    expect(disk.map((entry) => entry.identity)).toEqual(["99:10:20:101", "99:10:20:102"]);
    expect(admissions((await head.client.getEntries()).entries)).toEqual(disk);
    for (const receipt of disk)
      expect(await headReceipt(file, receipt.identity, receipt.fingerprint)).toEqual({
        outcome: "accepted",
        receipt: receipt.id,
      });
    const accepted = f.events.rows.filter(
      (event) => event.kind === "head-reply" && (event["reply"] as HeadReply).outcome === "accepted",
    );
    expect(accepted).toHaveLength(2);
    expect(accepted.every((event) => event["published"] === true)).toBe(true);
    expect(openOwes(f.stateDir, Date.now())).toHaveLength(2);

    const after = f.events.rows.length;
    await f.monitor(head, "start");
    expect(await f.intakeEnded(after)).toMatchObject({ code: 0 });
    expect(admissions((await head.client.getEntries()).entries)).toEqual(disk);
    expect(f.queued()).toEqual({ cursor: "102", pending: null, unresolved: null });
    await f.monitor(head, "stop");
    const recorded = (await head.client.getEntries()).entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "omp-dori:monitor",
    );
    expect(recorded.at(-1)).toMatchObject({ data: { op: "stop", name: "inbound" } });
    expect(f.events.rows.filter((event) => event.kind === "unexpected-http")).toEqual([]);
  });
}, 60_000);

test("actual native CLI: lost ACK and process reconnect reconcile one original receipt without resuming a paused goal", async () => {
  await withNativeIngress(async (f) => {
    f.seed(["101"]);
    const first = await f.start();
    await first.head.client.goal("create", { objective: "Retain the fixture pause until explicitly resumed" });
    expect((await first.head.client.goal("pause")).goal?.status).toBe("paused");
    await f.monitor(first.head, "start", "lose-ack");
    const lost = await f.events.wait((event) => event.kind === "lost-ack");
    const request = lost["request"] as HeadRequest,
      reply = lost["reply"] as HeadReply;
    expect(request).toMatchObject({ op: "dispatch", identity: "99:10:20:101" });
    expect(reply).toMatchObject({ outcome: "accepted", headFile: first.file, headPid: first.head.pid });
    expect(lost["published"]).toBe(true);
    const original = admissions((await first.head.client.getEntries()).entries);
    expect(original).toHaveLength(1);
    expect(f.pane()).toMatchObject({ goal: { status: "paused" } });

    const after = f.events.rows.length;
    await first.head.crash();
    await f.events.wait((event) => event.kind === "source-exit", after);
    // The receiver owned an exclusive queue lock until this real process exit.
    expect(f.queued()).toMatchObject({
      cursor: "100",
      unresolved: { identity: request.identity, headFile: first.file },
    });
    f.server.messages.splice(0); // Recovery must use its retained source and transcript, not REST history.
    const reconnectedAt = f.events.rows.length;
    const second = await f.start(first.file); // No role flag: native session records restore the Dori role.
    expect(second.id).toBe(first.id);
    expect(await f.intakeEnded(reconnectedAt)).toMatchObject({ code: 0 });
    expect(f.queued()).toEqual({ cursor: "101", pending: null, unresolved: null });
    const recovered = f.events.rows.slice(reconnectedAt).filter((event) => event.kind === "head-reply");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      published: true,
      request: { op: "reconcile", identity: request.identity },
      reply: { outcome: "accepted" },
    });
    expect(admissions((await second.head.client.getEntries()).entries)).toEqual(original);
    expect((await second.head.client.goal("get")).goal?.status).toBe("paused");
    expect(f.pane()).toMatchObject({ pid: second.head.pid, role: "dori", goal: { status: "paused" } });
  });
}, 60_000);

test("actual native CLI: real write approval can be cancelled; unreadable send ACK leaves the owner owe open", async () => {
  await withNativeIngress(async (f) => {
    f.seed(["101"]);
    const { head } = await f.start();
    await f.monitor(head, "start");
    await f.intakeEnded();
    const marker = join(f.root, "must-not-write.txt"),
      beforeApproval = f.events.rows.length;
    const writePrompt = await f.prompt(head, "CANCEL_REAL_WRITE", {
      name: "write",
      arguments: { path: marker, content: "not authorized" },
    });
    const approval = await f.events.wait(
      (event) => event.kind === "ui" && event["method"] === "select",
      beforeApproval,
    );
    expect(approval["options"]).toContain("Deny");
    expect(f.pane()).toMatchObject({ approvalPending: true });
    expect(existsSync(marker)).toBe(false);
    if (typeof approval["id"] !== "string") throw new Error("Native approval has no ID");
    // Pinned native approval waits for a host UI answer; abort alone does not dismiss that dialog.
    const aborted = head.client.abort();
    head.answer(approval["id"], undefined);
    await aborted;
    expect(
      await f.events.wait(
        (event) => event.kind === "rpc" && event["type"] === "prompt_result" && event["id"] === writePrompt,
        beforeApproval,
      ),
    ).toMatchObject({ status: "aborted" });
    head.answer(approval["id"], "Approve"); // A late answer to the cancelled dialog must not authorize the write.
    await head.client.waitForSettled(20_000);
    expect(existsSync(marker)).toBe(false);
    expect(f.pane()).toMatchObject({ approvalPending: false });
    expect(f.events.rows.slice(beforeApproval)).toContainEqual(
      expect.objectContaining({ kind: "tool-end", toolName: "write", isError: true }),
    );

    f.server.ambiguousSend();
    const beforeSend = f.events.rows.length;
    const sendPrompt = await f.prompt(head, "SEND_WITH_UNREADABLE_ACK", {
      name: "bash",
      arguments: { command: f.sendCommand() },
    });
    const sendApproval = await f.events.wait(
      (event) => event.kind === "ui" && event["method"] === "select",
      beforeSend,
    );
    expect(f.server.posts).toHaveLength(0);
    expect(sendApproval["options"]).toContain("Approve");
    if (typeof sendApproval["id"] !== "string") throw new Error("Native approval has no ID");
    head.answer(sendApproval["id"], "Approve");
    await f.events.wait(
      (event) => event.kind === "rpc" && event["type"] === "prompt_result" && event["id"] === sendPrompt,
      beforeSend,
    );
    expect(f.server.posts).toEqual([
      {
        content: "fixture answer",
        allowed_mentions: { parse: [] },
        message_reference: { message_id: "101", fail_if_not_exists: false },
      },
    ]);
    expect(f.events.rows.filter((event) => event.kind === "reaction")).toEqual([
      expect.objectContaining({ id: "101", published: true }),
    ]);
    expect(openOwes(f.stateDir, Date.now())).toHaveLength(1);
    const result = f.events.rows
      .slice(beforeSend)
      .filter((event) => event.kind === "tool-end" && event["toolName"] === "bash");
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result[0])).not.toContain("SENT ");
    expect(admissions((await head.client.getEntries()).entries)).toHaveLength(1);
    expect(f.queued()).toEqual({ cursor: "101", pending: null, unresolved: null });
    expect(f.pane()).toMatchObject({ approvalPending: false });
    expect(f.events.rows.filter((event) => event.kind === "unexpected-http")).toEqual([]);
  });
}, 60_000);
