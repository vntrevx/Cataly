import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { HeadAdmissions } from "../../../extension/head-admission.ts";
import { Monitors } from "../../../extension/monitor.ts";
import { assertNativeHost } from "./host.ts";
import { recordOwes } from "../../../skills/dori-mode/scripts/src/owes.ts";

const [root, mode, exitFile] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !exitFile || !process.send ||
  process.env["PI_CODING_AGENT_DIR"] !== join(root, "agent") || process.env["HOME"] !== root)
  throw new Error("native head fixture requires isolated native state and parent IPC");
await assertNativeHost();
/** Native full rewrites route through writeTextAtomic; holding it keeps an atomic batch unpublished. */
class HeldStorage extends FileSessionStorage {
  held: Promise<void> | undefined;
  override async writeTextAtomic(...args: Parameters<FileSessionStorage["writeTextAtomic"]>): Promise<void> {
    await this.held;
    return super.writeTextAtomic(...args);
  }
}
const storage = new HeldStorage();
const session = SessionManager.create(root, join(root, "sessions"), mode === "atomic-batch" ? storage : undefined);
await session.ensureOnDisk();
const file = session.getSessionFile();
if (!file) throw new Error("native head did not materialize its session");
const identity = session.getSessionId();
let contextManager = session;
const held = mode === "held" || mode === "backfill-held";
const cli = mode === "cli" || mode === "cli-unproven";
const admissions = new HeadAdmissions(
  () => mode === "absent" ? undefined : { id: identity, file, entries: () => contextManager.getEntries(), ensureOnDisk: () => contextManager.ensureOnDisk() },
  (details) => session.appendCustomEntry("omp-dori:admission-rejected", details),
  (pending, unresolved) => process.send?.({ event: "admission-status", pending, unresolved }),
);
const nativeHead = mode === "agent"
  ? await (await import("./native-message-head.ts")).nativeMessageHead(root, session, admissions) : undefined;
if (nativeHead) contextManager = nativeHead.manager;
const oweStarted = Promise.withResolvers<void>();
const monitors = new Monitors(async (content, delivery) => {
  const { details } = delivery;
  if (mode?.startsWith("owes-") && content.includes("INBOUND discord")) {
    process.send?.({ event: "before-owe", content, details });
    oweStarted.resolve();
    await recordOwes(join(root, "queue"), content, Date.now(), delivery.signal);
    if (!delivery.isCurrent()) return;
    process.send?.({ event: "owe-admitted", content, details });
  }
  if (!delivery.isCurrent()) return;
  if (details === undefined) {
    const exited = content.split("\n").some((line) => line.startsWith("[source] monitor exited ("));
    process.send?.({ event: exited ? "source-exited" : "diagnostic", content });
    return;
  }
  if (nativeHead) {
    process.send?.({ event: "handoff", content, details });
    nativeHead.send(content, details);
    return;
  }
  const message = { customType: "dori-monitor", content, details };
  if (mode === "atomic-batch") {
    // AgentSession persists message_end through appendCustomMessageEntry before extensions see it. During a native
    // appendEntriesAtomically batch (vibe mode changes) that append stays in memory until the batch publishes.
    void session
      .appendEntriesAtomically(() => {
        session.appendCustomEntry("omp-dori:fixture-batch", {});
        const publish = Promise.withResolvers<void>();
        storage.held = publish.promise;
        queueMicrotask(() => {
          const entry = session.appendCustomMessageEntry("dori-monitor", content, true, details);
          const published = readFileSync(file, "utf8").includes(`"id":"${entry}"`);
          process.send?.({ event: "handoff", content, details, entry, published });
          // The batch publishes once message_end is judged, or after a bound when the judgment awaits it.
          void Promise.race([admissions.messageEnded({ message }), Bun.sleep(50)]).then(() => publish.resolve());
        });
      })
      .catch((error: unknown) => process.send?.({ event: "diagnostic", content: String(error) }));
    return;
  }
  const entry = held || mode === "cli-unproven" ? undefined : session.appendCustomMessageEntry("dori-monitor", content, true, details);
  process.send?.({ event: "handoff", content, details, entry });
  if (mode !== "lost-ack" && !held) void admissions.messageEnded({ message });
}, () => mode === "absent" ? undefined : identity, 5, admissions);
const repo = resolve(import.meta.dir, "../../..");
const argv = cli ? [process.execPath, "--preload",
  join(repo, "skills/dori-mode/scripts/test/record-discord-inbound.ts"),
  join(repo, "skills/dori-mode/scripts/src/cli.ts"), "inbound", "discord",
  ...(mode === "cli" ? ["--loop", "0"] : []), "--context"] :
  [process.execPath, join(repo, "extension/test/record-head-inbound.ts"), join(root, "queue"), exitFile, mode ?? "accepted"];
if (cli) {
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: join(root, "queue"), runtime: "herdr", hooks: {} }));
  Object.assign(process.env, { DORI_CONFIG: config, DORI_STATE_DIR: join(root, "queue"),
    DORI_DISCORD_TOKEN: "synthetic-inbound-token", DORI_DISCORD_OWNER_ID: "10", DORI_DISCORD_CHANNEL_ID: "20",
    DORI_TEST_DISCORD_CASE: "context" });
}
if (mode === "owes-serial") {
  monitors.start("prior", [process.execPath, "--eval",
    'console.log(' + JSON.stringify('INBOUND discord 20 90 from=owner ref=- "prior"') + ');setInterval(()=>{},1000)'],
    "^INBOUND", root, identity);
  await oweStarted.promise;
}
monitors.start("source", argv, mode === "filtered" ? "NO_SOURCE_RECORD_MATCHES" : "^INBOUND", root, identity);
process.send({ event: "ready", file, sourcePid: monitors.list().find((entry) => entry.name === "source")?.pid });
const stop = async () => {
  monitors.stopAll();
  await nativeHead?.close();
  await session.close();
  process.exit(0);
};
process.on("message", (message: unknown) => {
  if (message === null || typeof message !== "object" || !("op" in message)) return;
  if (message.op === "stop") void stop();
  else if (message.op === "cancel-admission") {
    const source = monitors.list().find((entry) => entry.name === "source");
    if (!source) throw new Error("fixture source is not live");
    admissions.stop(source.pid);
  } else if (message.op === "stop-monitors") {
    monitors.stopAll();
    process.send?.({ event: "monitors-stopped" });
  } else if (message.op === "restart-source") {
    const resumed = [...argv];
    resumed[3] = join(root, "restart-exit");
    monitors.start("source", resumed, "^INBOUND", root, identity);
  }
});
process.once("disconnect", () => void stop());
