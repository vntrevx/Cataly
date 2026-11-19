import { randomUUID } from "node:crypto";
import { exactModelIdentity, type ModelSnapshot } from "../src/lane-state.ts";

export const snapshotFor = (model: string, requested = model): ModelSnapshot => {
  const identity = exactModelIdentity(model);
  if (!identity) throw new Error(`invalid fixture model ${model}`);
  return {
    version: 1,
    id: randomUUID(),
    model: identity,
    modelRoles: { default: model, task: model },
    defaultThinkingLevel: "high",
    configuredThinkingLevel: "high",
    thinkingLevel: "high",
    capturedAt: "2026-01-01T12:00:00.000Z",
    provenance: {
      kind: "launch",
      requested,
      modelRoles: { default: "global", task: "global" },
      defaultThinkingLevel: "global",
    },
  };
};
