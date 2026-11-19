import { expect, spyOn, test } from "bun:test";
import { discordInbound } from "../src/messenger/discord-inbound.ts";
import { discordInboundQueue } from "../src/messenger/discord-inbound-queue.ts";
import { headEmitter } from "../src/messenger/head-admission.ts";
import { discordRestWorld, ownerMessage } from "./discord-inbound-fakes.ts";
import { withState } from "./fakes.ts";

test("cancellation during context and owe preparation preserves raw input without stdout", async () => {
  const state = withState();
  const queue = discordInboundQueue(state.dir);
  const output = spyOn(console, "log").mockImplementation(() => {});
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const controller = new AbortController();
  const reason = new Error("owned intake cancellation");
  try {
    queue.storeFor("20").save("100");
    queue.push("message", ownerMessage("101"));
    const world = discordRestWorld([]);
    const intake = await discordInbound(world.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });
    const emit = headEmitter(queue, intake.botId, "10", async (_message, signal) => {
      entered.resolve();
      expect(signal).toBe(controller.signal);
      await resume.promise;
      return "must not publish after cancellation";
    });
    const pending = intake.accept(ownerMessage("101"), (message) => emit(message, controller.signal));
    // Bun promise matchers wait eagerly; observe the result without blocking the abort operation.
    const observed = pending.then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
    await entered.promise;
    controller.abort(reason);
    resume.resolve();
    const result = await observed;
    expect(result.rejected).toBe(true);
    expect(result.error).toBe(reason);
    expect(output).not.toHaveBeenCalled();
    expect(queue.storeFor("20").load()).toBe("100");
    expect(JSON.parse(queue.first()!.payload).id).toBe("101");
    expect(queue.unresolved()).toBeNull();
  } finally {
    resume.resolve();
    output.mockRestore();
    queue.close();
    state.done();
  }
});

test.each(["prepare", "dispatch", "reconcile"] as const)(
  "native %s cancellation settles IPC without advancing or leaking listeners",
  async (stage) => {
    const state = withState();
    const requests: string[] = [];
    const script = [
      'import { join } from "node:path";',
      "import { discordInbound, formatDiscordInbound } from " +
        JSON.stringify(new URL("../src/messenger/discord-inbound.ts", import.meta.url).href) +
        ";",
      "import { discordInboundQueue } from " +
        JSON.stringify(new URL("../src/messenger/discord-inbound-queue.ts", import.meta.url).href) +
        ";",
      "import { headEmitter } from " +
        JSON.stringify(new URL("../src/messenger/head-admission.ts", import.meta.url).href) +
        ";",
      "import { discordSourceFingerprint } from " +
        JSON.stringify(new URL("../src/messenger/discord-source-fingerprint.ts", import.meta.url).href) +
        ";",
      "import { toInbound } from " +
        JSON.stringify(new URL("../src/messenger/discord-inbound-api.ts", import.meta.url).href) +
        ";",
      "import { discordRestWorld, ownerMessage } from " +
        JSON.stringify(new URL("./discord-inbound-fakes.ts", import.meta.url).href) +
        ";",
      "const [dir, stage] = process.argv.slice(1);",
      "const queue = discordInboundQueue(dir, true);",
      'queue.storeFor("20").save("100");',
      'queue.push("message", ownerMessage("101")); queue.push("message", ownerMessage("102"));',
      'const input = toInbound(ownerMessage("101"));',
      'if (stage === "reconcile") queue.attempt({ identity: "99:10:20:101", fingerprint: discordSourceFingerprint(input), headFile: join(dir, "original.jsonl"), headPid: process.ppid, source: input });',
      'const controller = new AbortController(); const reason = new Error("owned IPC cancellation");',
      "let settled = false; let cancelled = false;",
      'const before = [process.listenerCount("message"), process.listenerCount("disconnect")];',
      'const cancel = (raw) => { if (raw?.protocol !== "test-cancel") return; controller.abort(reason); setImmediate(() => { if (!settled) { console.error("cancelled IPC did not settle"); process.exit(2); } }); };',
      'process.on("message", cancel);',
      "try {",
      "  const world = discordRestWorld([]);",
      '  const intake = await discordInbound(world.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });',
      '  const emit = headEmitter(queue, intake.botId, "10", formatDiscordInbound);',
      '  await intake.accept(ownerMessage("101"), (message) => emit(message, controller.signal));',
      "  queue.remove(queue.first().id);",
      "} catch (error) { cancelled = error === reason; }",
      'finally { settled = true; process.off("message", cancel); }',
      'console.log(JSON.stringify({ cancelled, cursor: queue.storeFor("20").load(), first: JSON.parse(queue.first().payload).id, unresolved: queue.unresolved()?.identity ?? null, listenerDelta: [process.listenerCount("message") - before[0], process.listenerCount("disconnect") - before[1]] }));',
      "queue.close(); process.exit(0);",
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "--eval", script, state.dir, stage], {
      env: { ...process.env, DORI_MONITOR_ADMISSION: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      serialization: "json",
      ipc(raw: unknown) {
        const message = raw as { protocol: string; op: string; request: string };
        if (message.protocol !== "dori-head-admission-v1") return;
        requests.push(message.op);
        if (message.op === stage) proc.send({ protocol: "test-cancel" });
        else if (message.op === "prepare" && stage === "dispatch")
          proc.send({
            protocol: message.protocol,
            request: message.request,
            outcome: "ready",
            headFile: `${state.dir}/original.jsonl`,
            headPid: process.pid,
          });
      },
    });
    const output = new Response(proc.stdout).text();
    const errors = new Response(proc.stderr).text();
    try {
      expect(await proc.exited).toBe(0);
      expect(await errors).toBe("");
      expect(requests).toEqual(stage === "dispatch" ? ["prepare", "dispatch"] : [stage]);
      expect(JSON.parse(await output)).toEqual({
        cancelled: true,
        cursor: "100",
        first: "101",
        unresolved: stage === "prepare" ? null : "99:10:20:101",
        listenerDelta: [0, 0],
      });
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await proc.exited;
      state.done();
    }
  },
);
