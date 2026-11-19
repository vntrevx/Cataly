import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HeadReply, HeadRequest } from "../../skills/dori-mode/scripts/src/messenger/head-admission.ts";

/** Transparent Bun IPC bridge. The only fault is losing one already-persisted dispatch ACK. */
const [cli, guard, root, fault] = process.argv.slice(2);
if (!cli || !guard || !root || !process.send || !process.connected) throw new Error("Native bridge needs its owning monitor");
const marker = join(root, "lost-ack");
const requests = new Map<string, HeadRequest>();
const report = async (event: Record<string, unknown>) => {
  const response = await fetch(`${process.env["DORI_TEST_INGRESS_ORIGIN"]}/control`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error("Native ingress fixture control failed");
};
const child = Bun.spawn([process.execPath, "--preload", guard, cli, "inbound", "discord", "--loop", "0"], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit", serialization: "json",
  ipc(message: HeadRequest) {
    requests.set(message.request, message);
    process.send!(message);
  },
});
process.on("message", (reply: HeadReply) => {
  const request = requests.get(reply.request);
  if (!request) throw new Error("Native admission reply has no original request");
  requests.delete(reply.request);
  void (async () => {
    const lost = fault === "lose-ack" && request.op === "dispatch" && reply.outcome === "accepted" && !existsSync(marker);
    if (lost) writeFileSync(marker, JSON.stringify({ request, reply }), { mode: 0o600, flag: "wx" });
    await report({ kind: lost ? "lost-ack" : "head-reply", request, reply });
    if (!lost) child.send(reply);
  })().catch((error: unknown) => { console.error(error); child.kill(); process.exitCode = 1; });
});
const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
process.once("disconnect", () => child.disconnect());
process.once("SIGTERM", stop);
const code = await child.exited;
await report({ kind: "source-exit", code, pid: process.pid, sourcePid: child.pid });
process.exit(process.exitCode ?? code);
