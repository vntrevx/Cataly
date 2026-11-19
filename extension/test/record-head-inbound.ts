import { writeFileSync } from "node:fs";
import { discordInbound, formatDiscordInbound } from "../../skills/dori-mode/scripts/src/messenger/discord-inbound.ts";
import { discordInboundQueue } from "../../skills/dori-mode/scripts/src/messenger/discord-inbound-queue.ts";
import { headEmitter, reconcileHead } from "../../skills/dori-mode/scripts/src/messenger/head-admission.ts";
import { discordRestWorld, ownerMessage } from "../../skills/dori-mode/scripts/test/discord-inbound-fakes.ts";

const [stateDir, exitFile, mode] = process.argv.slice(2);
if (!stateDir || !exitFile) throw new Error("receiver fixture needs its isolated queue and exit marker");
process.once("exit", (code) => writeFileSync(exitFile, String(code)));
const queue = discordInboundQueue(stateDir, true);
let code = 0;
try {
  await reconcileHead(queue);
  // A resumed Gateway can redeliver the same source records before backlog draining.
  if (mode?.startsWith("backfill-")) queue.push("sync", {});
  queue.push("message", ownerMessage("101"));
  queue.push("message", ownerMessage("102"));
  const world = discordRestWorld(
    mode === "backfill-deleted"
      ? [ownerMessage("102")]
      : mode === "backfill-held"
        ? [ownerMessage("101"), ownerMessage("102")]
        : [],
  );
  const intake = await discordInbound(world.discord, queue.storeFor, { ownerId: "10", channelIds: ["20"] });
  const emit = headEmitter(queue, intake.botId, "10", formatDiscordInbound);
  for (let next = queue.first(); next; next = queue.first()) {
    if (next.kind === "sync") await intake.poll(emit);
    else await intake.accept(JSON.parse(next.payload), emit);
    queue.remove(next.id);
  }
} catch (error) {
  code = 1;
  console.error(error instanceof Error ? error.message : "receiver failed");
} finally {
  queue.close();
}
process.exit(code);
