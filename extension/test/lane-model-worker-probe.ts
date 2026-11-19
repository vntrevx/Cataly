import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { DoriApi } from "../index.ts";

/** Directory the probe writes one record per subagent session into; a worker thread inherits it from the test. */
export const WORKER_PROBE_ENV = "DORI_TEST_WORKER_PROBE";

/**
 * Test-only native extension, loaded by path so worker-thread subagents load it too. For each subagent session it
 * records where the session runs, whether its settings read through a worker mirror of the root's, and its model/effort.
 */
export default async function workerProbe(pi: DoriApi): Promise<void> {
  // Runtime-selected: the native loader routes this specifier to the running host's own module graph.
  const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  pi.on("session_start", (_event, ctx) => {
    const dir = process.env[WORKER_PROBE_ENV];
    if (!dir || ctx.agent.kind !== "sub") return;
    let root = findScopedSettings();
    for (let parent = root?.overlayParent(); parent; parent = parent.overlayParent()) root = parent;
    writeFileSync(
      join(dir, `${encodeURIComponent(ctx.agent.id)}.json`),
      JSON.stringify({
        mainThread: isMainThread,
        mirror: root?.isMirror ?? null,
        model: ctx.model?.id ?? null,
        thinkingLevel: pi.getThinkingLevel() ?? null,
      }),
    );
  });
  // Test-only barrier: let an already-started worker reach its provider boundary before the parent changes native
  // thinking. Dori's real provider guard runs next, after this explicit permit is released.
  pi.on("before_provider_request", async (_event, ctx) => {
    const dir = process.env[WORKER_PROBE_ENV];
    if (!dir || ctx.agent.kind !== "sub") return;
    const hold = join(dir, `${encodeURIComponent(ctx.agent.id)}.hold`);
    if (!existsSync(hold)) return;
    writeFileSync(`${hold}.waiting`, "");
    const deadline = Date.now() + 10_000;
    while (existsSync(hold)) {
      if (Date.now() >= deadline) throw new Error("worker provider fixture permit was not released");
      await Bun.sleep(10);
    }
  });
}
