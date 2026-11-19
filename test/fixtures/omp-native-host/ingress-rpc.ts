import { join } from "node:path";
import type { Subprocess } from "bun";
import { RpcClient } from "@oh-my-pi/pi-coding-agent";
import type { IngressEvents } from "../../native-ingress-events.ts";
import { assertNativeHost } from "./host.ts";

/** Public pinned-host client, with an env-isolated real CLI process instead of an SDK-created AgentSession. */
export async function nativeIngressRpc(
  root: string,
  env: Record<string, string>,
  events: IngressEvents,
  extension: string,
  guard: string,
  sessionFile?: string,
) {
  await assertNativeHost();
  const host = process.env["DORI_TEST_OMP_ROOT"]!;
  let proc: Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let stderr = "";
  let stderrDone: Promise<void> | undefined;
  let framesDone: Promise<void> | undefined;
  const client = new RpcClient({
    provider: "ingress-local", model: "ingress-fixture", sessionDir: join(root, "sessions"),
    args: ["--no-extensions", "--extension", extension, "--no-skills", "--no-rules", "--no-context-files",
      "--no-title", "--no-prewalk", "--no-lsp", "--tools", "write,bash,monitor", "--approval-mode", "always-ask",
      "--system-prompt", "Execute only the deterministic local fixture instructions.", "--api-key", "fixture-only",
      "--config", join(root, "settings.yml"), ...(sessionFile ? ["--session", sessionFile] : ["--dori-role", "dori"])],
    spawn(args) {
      const child = Bun.spawn([process.execPath, "--preload", guard, join(host, "dist/cli.js"), ...args], {
        cwd: join(root, "work"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      });
      proc = child;
      stderrDone = (async () => {
        const decoder = new TextDecoder();
        for await (const part of child.stderr) stderr = (stderr + decoder.decode(part, { stream: true })).slice(-32_768);
      })();
      const [rpc, observed] = child.stdout.tee();
      // RpcClient owns framing/commands. Tap only small public UI frames, which it has no public subscription for.
      framesDone = (async () => {
        const decoder = new TextDecoder();
        let pending = "";
        for await (const part of observed) {
          pending += decoder.decode(part, { stream: true });
          for (let lf = pending.indexOf("\n"); lf >= 0; lf = pending.indexOf("\n")) {
            const line = pending.slice(0, lf);
            pending = pending.slice(lf + 1);
            if (!line.trim()) continue;
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (frame["type"] === "extension_ui_request") events.record({ ...frame, kind: "ui" });
            else if (["ready", "prompt_result", "session_settled"].includes(String(frame["type"])))
              events.record({ ...frame, kind: "rpc" });
          }
        }
      })();
      void framesDone.catch((error: unknown) => { events.record({ kind: "rpc-read-error", error: String(error) }); child.kill(); });
      return {
        stdin: child.stdin, stdout: rpc, peekStderr: () => stderr,
        kill(_reason, graceMs = 1_000) {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, graceMs);
          void child.exited.then(() => clearTimeout(timer));
        },
        exited: child.exited.then(async (code) => { await stderrDone; return code; }),
      };
    },
  });
  client.onEvent((event) => {
    if (event.type === "tool_execution_end") events.record({ kind: "tool-end", ...event });
    else if (event.type === "message_end" && event.message.role === "custom")
      events.record({ kind: "native-message", message: event.message });
  });
  try {
    await client.start();
    await client.setAutoRetry(false);
    await client.setCacheWarming("off");
  } catch (error) {
    await client.stop();
    throw new Error(`Real native CLI startup failed: ${String(error)}\n${stderr}`);
  }
  return {
    client,
    get pid() { return proc!.pid; },
    get stderr() { return stderr; },
    answer(id: string, value: string | undefined) {
      proc!.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, value, cancelled: value === undefined })}\n`);
    },
    async crash() { proc!.kill("SIGKILL"); await proc!.exited; await client.stop(); await framesDone; },
    async close() { await client.stop(); await framesDone; await stderrDone; },
  };
}
