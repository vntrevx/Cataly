import { parentPort, workerData } from "node:worker_threads";
import { nativeComposition } from "./compose.ts";

if (!parentPort) throw new Error("policy worker fixture must run in a worker thread");
const input = workerData as { entry: string; file: string; parentSession: string; id: string; parentId: string };
const result = await nativeComposition([input.entry], ["worker policy fixture"], {
  agent: { kind: "sub", id: input.id, parentId: input.parentId, name: "task", depth: 1 },
  session: { file: input.file, parentSession: input.parentSession },
  bash: { command: "sudo true", approvalMode: "yolo" },
});
parentPort.postMessage(result);
parentPort.close();
