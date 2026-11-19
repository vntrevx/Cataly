import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readPaneState } from "../skills/dori-mode/scripts/src/lane-state.ts";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discordInboundQueue } from "../skills/dori-mode/scripts/src/messenger/discord-inbound-queue.ts";
import { nativeIngressRpc } from "./fixtures/omp-native-host/ingress-rpc.ts";
import { IngressEvents } from "./native-ingress-events.ts";
import { ingressServer, type IngressTool, ownerMessage } from "./native-ingress-server.ts";

type NativeHead = Awaited<ReturnType<typeof nativeIngressRpc>>;
const repo = resolve(import.meta.dir, "..");
const guard = join(repo, "test/fixtures/native-ingress-network.ts");
const cli = join(repo, "skills/dori-mode/scripts/src/cli.ts");
const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dori-native-ingress-")));
  const stateDir = join(root, "dori/state"),
    agent = join(root, "agent"),
    config = join(root, "dori/config.json");
  for (const path of [stateDir, agent, join(root, "work")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(config, JSON.stringify({ runtime: "herdr", stateDir, ompUlwPath: "", hooks: {} }), { mode: 0o600 });
  const events = new IngressEvents(),
    server = ingressServer(events);
  writeFileSync(
    join(agent, "models.yml"),
    JSON.stringify({
      providers: {
        "ingress-local": {
          baseUrl: `${server.origin}/v1`,
          api: "openai-completions",
          apiKey: "fixture-only",
          models: [
            {
              id: "ingress-fixture",
              name: "Local ingress fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 131_072,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "settings.yml"),
    JSON.stringify({
      update: { auto: false },
      prewalk: { enabled: false, auto: "off" },
      retry: { enabled: false, modelFallback: false },
      compaction: { enabled: false },
      async: { widgets: false },
      goal: { enabled: true, continuationModes: [] },
      power: { sleepPrevention: "off" },
    }),
    { mode: 0o600 },
  );
  const env = {
    HOME: root,
    PATH: `${dirname(process.execPath)}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: agent,
    XDG_CONFIG_HOME: join(root, "xdg"),
    DORI_HOME: join(root, "dori"),
    DORI_CONFIG: config,
    DORI_STATE_DIR: stateDir,
    DORI_DISCORD_TOKEN: "synthetic-local-only",
    DORI_DISCORD_OWNER_ID: "10",
    DORI_DISCORD_CHANNEL_ID: "20",
    DORI_DISCORD_API_BASE: `${server.origin}/api/v10`,
    DORI_TEST_INGRESS_ORIGIN: server.origin,
    HERDR_PANE_ID: "w980:p1",
  };
  const heads: NativeHead[] = [];
  let serial = 0;
  const queued = () => {
    const queue = discordInboundQueue(stateDir);
    try {
      return { cursor: queue.storeFor("20").load(), pending: queue.first(), unresolved: queue.unresolved() };
    } finally {
      queue.close();
    }
  };
  const monitor = async (head: NativeHead, op: "start" | "stop", fault = "none") => {
    await head.client.waitForSettled(20_000);
    const marker = `MONITOR_${op}_${++serial}`;
    server.action(marker, {
      name: "monitor",
      arguments: {
        op,
        name: "inbound",
        ...(op === "start"
          ? {
              argv: [
                process.execPath,
                "--preload",
                guard,
                join(repo, "test/fixtures/native-ingress-bridge.ts"),
                cli,
                guard,
                root,
                fault,
              ],
              filter: "^INBOUND",
            }
          : {}),
      },
    });
    // Only this explicitly requested, fixture-local monitor operation may be approved by the harness.
    const unlisten = events.listen((event) => {
      if (event.kind !== "ui" || event["method"] !== "select") return;
      if (
        event["title"] !== "Allow tool: monitor" ||
        typeof event["id"] !== "string" ||
        !Array.isArray(event["options"]) ||
        !event["options"].includes("Approve")
      )
        throw new Error("Unexpected monitor approval shape");
      head.answer(event["id"], "Approve");
    });
    try {
      await head.client.promptAndWait(marker, undefined, 20_000);
    } finally {
      unlisten();
    }
  };
  return {
    root,
    stateDir,
    config,
    env,
    events,
    server,
    queued,
    monitor,
    async intakeEnded(after = 0) {
      const exit = await events.wait((event) => event.kind === "source-exit", after);
      await events.wait((event) => {
        const message = event["message"] as { customType?: string; content?: unknown } | undefined;
        return (
          event.kind === "native-message" &&
          message?.customType === "dori-monitor" &&
          typeof message.content === "string" &&
          message.content.includes("[inbound] monitor exited")
        );
      }, after);
      return exit;
    },
    seed(ids: string[]) {
      server.messages.splice(0, server.messages.length, ...ids.map(ownerMessage));
      const queue = discordInboundQueue(stateDir);
      try {
        queue.storeFor("20").save("100");
      } finally {
        queue.close();
      }
    },
    async start(sessionFile?: string) {
      const head = await nativeIngressRpc(root, env, events, join(repo, "extension/index.ts"), guard, sessionFile);
      heads.push(head);
      const state = await head.client.getState();
      if (!state.sessionFile) throw new Error("Actual native CLI did not select a transcript");
      server.bind(state.sessionFile);
      return { head, file: state.sessionFile, id: state.sessionId };
    },
    async absent() {
      const child = Bun.spawn([process.execPath, "--preload", guard, cli, "inbound", "discord", "--loop", "0"], {
        cwd: join(root, "work"),
        env: { ...env, DORI_MONITOR_ADMISSION: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      events.record({ kind: "head-absent", code, out, err });
      return { code, out, err };
    },
    async prompt(head: NativeHead, marker: string, tool: IngressTool) {
      await head.client.waitForSettled(20_000);
      server.action(marker, tool);
      return head.client.prompt(marker);
    },
    sendCommand() {
      const prefix = [process.execPath, "--preload", guard, cli];
      return [
        [...prefix, "react", "discord", "--to", "20", "--message", "101"],
        [...prefix, "send", "discord", "--to", "20", "--reply", "101", "--text", "fixture answer"],
      ]
        .map((argv) => argv.map(quote).join(" "))
        .join(" && ");
    },
    pane() {
      return readPaneState(stateDir, "w980:p1");
    },
    diagnostics() {
      return JSON.stringify({ root, events: events.rows.slice(-50), stderr: heads.map((head) => head.stderr) }).slice(
        -60_000,
      );
    },
    async close() {
      const closed = await Promise.allSettled(heads.map((head) => head.close()));
      try {
        server.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      const failed = closed.filter((result) => result.status === "rejected");
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          "Native CLI cleanup failed",
        );
    },
  };
}

export async function withNativeIngress(run: (value: ReturnType<typeof fixture>) => Promise<void>): Promise<void> {
  const value = fixture(),
    failures: unknown[] = [];
  try {
    await run(value);
  } catch (error) {
    console.error(`NATIVE_INGRESS_DIAGNOSTICS ${value.diagnostics()}`);
    failures.push(error);
  } finally {
    try {
      await value.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Native ingress and cleanup failed");
}
