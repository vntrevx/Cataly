import { inboundActivity } from "../src/update/source-activity.ts";

// Only the admission clock is advanced; the receiver, writer lease and process identities are real.
if (import.meta.main) {
  let clock = Date.now() - 1_900_000;
  const activity = inboundActivity(process.argv[2]!, "discord", () => clock)!;
  activity.healthy();
  clock = Date.now();
  activity.healthy();
  const timer = setInterval(() => {
    clock = Date.now();
    activity.healthy();
  }, 100);
  try {
    console.log("ready");
    await Bun.stdin.text();
  } finally {
    clearInterval(timer);
    activity.close();
  }
}
