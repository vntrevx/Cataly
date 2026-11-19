import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { evidenceClock, fileEvidence } from "../../skills/dori-mode/scripts/src/evidence.ts";
import { Registry } from "../../skills/dori-mode/scripts/src/registry.ts";
import { Reports } from "../../skills/dori-mode/scripts/src/reports.ts";
import { type FakePi, load, useConfig } from "./fake-pi";

test("dori_report scopes reopened evidence while sharing the journal acceptance sequence", async () => {
  const names = ["DORI_CONFIG", "DORI_STATE_DIR", "HERDR_PANE_ID", "HC_TERMINAL_ID"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let pi: FakePi | undefined;
  try {
    const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
    const key = "generation-evidence";
    const generation = randomUUID();
    const oldGeneration = randomUUID();
    process.env.HERDR_PANE_ID = "w1:p5";
    delete process.env.HC_TERMINAL_ID;
    await new Registry(stateDir).write({
      key,
      title: "reopened evidence",
      thread: "none",
      pane: "w1:p5",
      brief: "/brief.md",
      done: "file /done.md",
      openedAt: "2026-01-02T00:00:00.000Z",
      lifecycleEpoch: generation,
      reportProtocol: "jsonl-v1",
    });
    const source = join(dirname(stateDir), "result.txt");
    writeFileSync(source, "unchanged across reopen");
    const refs = [fileEvidence(source, stateDir)];
    const reports = new Reports(stateDir);
    const old = await reports.report(
      key,
      "done",
      "old generation finished",
      Date.parse("2026-01-01T00:00:00Z"),
      oldGeneration,
      refs,
    );
    pi = await load({ session: { id: "generation-session", entries: [] }, flags: { "dori-role": "lane" } });
    await pi.emit("session_start");
    const tool = pi.tools.get("dori_report");
    if (!tool) throw new Error("dori_report is not registered");
    const params = { kind: "milestone", text: "new generation report", files: [source] };
    const first = await tool.execute("first-report", params, undefined, undefined, pi.ctx());
    expect(first.content.map((block) => block.text).join("\n")).toEndWith(
      "1 of 1 evidence items are new; the evidence clock moved",
    );
    const current = reports.read(key, { generation });
    expect(current?.lastReport).toMatchObject({ generation, evidenceRefs: refs, evidenceSequence: 2 });
    expect(reports.read(key, { generation: oldGeneration })?.lastReport).toEqual(old);
    const clock = evidenceClock(current?.evidenced ?? []);
    const again = await tool.execute("second-report", params, undefined, undefined, pi.ctx());
    expect(again.content.map((block) => block.text).join("\n")).toEndWith(
      "the same evidence was recorded before; the evidence clock did not move",
    );
    expect(evidenceClock(reports.read(key, { generation })?.evidenced ?? [])).toEqual(clock);
    expect(reports.read(key)?.evidenced.map((entry) => entry.evidenceSequence)).toEqual([1, 2, 3]);
  } finally {
    await pi?.emit("session_shutdown");
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
