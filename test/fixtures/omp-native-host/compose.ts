import { realpathSync } from "node:fs";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  ExtensionRuntime,
  importExtensionModule,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
  emitSessionShutdownEvent,
  ExtensionRunner,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
  Extension,
  ExtensionAgentIdentity,
  ExtensionContext,
  ExtensionFactory,
  PreparedExtension,
  RegisteredTool,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper, wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { assertNativeHost } from "./host.ts";

type FixtureModel = NonNullable<ExtensionContext["model"]>;

const preparedFactories = new Map<string, Promise<PreparedExtension>>();

/** Rebind the same canonically prepared module across parent and subagent sessions, as the native host does. */
export const nativeExtensionFactory = async (entry: string): Promise<ExtensionFactory> => {
  await assertNativeHost();
  const selected = realpathSync(entry);
  let pending = preparedFactories.get(selected);
  if (!pending) {
    pending = importExtensionModule(selected, import.meta.dir);
    preparedFactories.set(selected, pending);
  }
  const prepared = await pending;
  if (!prepared.factory) throw new Error(prepared.error ?? `no extension factory at ${selected}`);
  if (prepared.error) throw new Error(prepared.error);
  return prepared.factory;
};

// A complete native Model with no transport implementation, catalog resolution, auth or provider request.
export const SOL_MODEL = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  api: "fixture",
  provider: "openai-codex",
  baseUrl: "http://127.0.0.1:0",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500_000,
  maxTokens: 128_000,
  identity: { class: "unknown" },
  compat: undefined,
} satisfies FixtureModel;

export const nativeComposition = async (
  entries: readonly string[],
  base: string[],
  options: {
    role?: "dori" | "lane";
    model?: FixtureModel;
    agent?: ExtensionAgentIdentity;
    observeBefore?: string;
    command?: { name: string; args: string; beforePrompt?: boolean };
    bash?: { command: string; approvalMode: "yolo" | "always-ask" };
    session?: { file: string; parentSession?: string };
  },
) => {
  await assertNativeHost();
  const runtime = new ExtensionRuntime();
  const events = new EventBus();
  const cwd = import.meta.dir;
  const session = options.session
    ? await SessionManager.open(options.session.file, undefined, undefined, {
        initialCwd: cwd, suppressBreadcrumb: true,
        ...(options.session.parentSession ? { parentSession: options.session.parentSession } : {}),
      })
    : SessionManager.inMemory(cwd);
  if (options.role) runtime.flagValues.set("dori-role", options.role);
  const extensions: Extension[] = [];
  const beforeDori: string[][] = [];
  const afterAll: string[][] = [];
  const observe = (name: string, snapshots: string[][]) =>
    loadExtensionFromFactory(
      (api) => {
        api.on("before_agent_start", (event) => {
          snapshots.push([...event.systemPrompt]);
          // Deliberately decline: the real runner must retain the earlier combined winner.
        });
      },
      cwd,
      events,
      runtime,
      name,
    );
  for (const entry of entries) {
    if (entry === options.observeBefore) extensions.push(await observe("before-dori", beforeDori));
    const factory = await nativeExtensionFactory(entry);
    extensions.push(await loadExtensionFromFactory(factory, cwd, events, runtime, entry));
  }
  extensions.push(await observe("declining-final-handler", afterAll));
  let bashTool: RegisteredTool | undefined;
  let executions = 0;
  let approvals = 0;
  if (options.bash) {
    const fixture = await loadExtensionFromFactory((api) => {
      api.registerTool({
        name: "bash", label: "Fixture bash", description: "Count admission without running a process",
        parameters: api.zod.object({ command: api.zod.string() }),
        async execute() {
          executions++;
          return { content: [{ type: "text", text: "fixture admitted" }], details: {} };
        },
      });
      api.on("tool_approval_requested", () => { approvals++; });
    }, cwd, events, runtime, "policy-tool-fixture");
    extensions.push(fixture);
    bashTool = fixture.tools.get("bash");
  }
  // No auth-backed registry is constructed. Any unexpected registry access fails this guard.
  const registry = new Proxy({} as ModelRegistry, {
    get: (_target, key) => {
      throw new Error(`native prompt fixture unexpectedly accessed the model registry: ${String(key)}`);
    },
  });
  const settings = Settings.isolated({
    "prewalk.auto": "off", "prewalk.enabled": false,
    ...(options.bash ? { "tools.approvalMode": options.bash.approvalMode } : {}),
  });
  const runner = new ExtensionRunner(
    extensions,
    runtime,
    cwd,
    session,
    registry,
    undefined,
    settings,
    undefined,
    undefined,
    options.agent,
  );
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  const forbidden = (): never => {
    throw new Error("native prompt fixture attempted an action outside prompt composition");
  };
  let active: string[] = [];
  const userMessages: string[] = [];
  runner.initialize(
    {
      sendMessage: forbidden,
      sendUserMessage: options.command
        ? async (content) => {
            if (typeof content !== "string") throw new Error("native command fixture requires a text user message");
            userMessages.push(content);
          }
        : forbidden,
      appendEntry: (type, data) => void session.appendCustomEntry(type, data),
      setLabel: forbidden,
      getActiveTools: () => [...active],
      getAllTools: () => [],
      setActiveTools: async (names) => {
        active = [...names];
      },
      getCommands: () => [],
      setModel: forbidden,
      getThinkingLevel: () => undefined,
      setThinkingLevel: forbidden,
      getSessionName: () => undefined,
      setSessionName: forbidden,
    },
    {
      getModel: () => options.model ?? SOL_MODEL,
      isIdle: () => true,
      abort: forbidden,
      hasPendingMessages: () => false,
      shutdown: forbidden,
      getContextUsage: () => undefined,
      compact: forbidden,
      getSystemPrompt: () => base,
    },
  );
  const invokeCommand = async (): Promise<void> => {
    const request = options.command;
    if (!request) return;
    const command = runner.getCommand(request.name);
    if (!command) throw new Error(`no native command ${request.name}`);
    await runner.runScoped(() => command.handler(request.args, runner.createCommandContext()));
  };
  try {
    await runner.emit({ type: "session_start" });
    if (options.command?.beforePrompt) await invokeCommand();
    const first = await runner.emitBeforeAgentStart("ulw fix the fixture", undefined, base);
    const second = await runner.emitBeforeAgentStart("ulw fix the fixture", undefined, base);
    if (options.command && !options.command.beforePrompt) await invokeCommand();
    let toolError: string | undefined;
    if (options.bash) {
      if (!bashTool) throw new Error("native fixture did not register bash");
      const tool = new ExtensionToolWrapper(wrapRegisteredTool(bashTool, runner), runner);
      try {
        await tool.execute("policy-call", { command: options.bash.command });
      } catch (error) {
        toolError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      tool: { executions, approvals, error: toolError },
      firstResult: first,
      secondResult: second,
      first: first?.systemPrompt,
      second: second?.systemPrompt,
      beforeDori,
      afterAll,
      userMessages,
      entries: session.getBranch(),
    };
  } finally {
    try {
      await emitSessionShutdownEvent(runner);
    } finally {
      settings.stopWatching();
      await settings.flush();
      await session.flush();
    }
    if (errors.length) throw new AggregateError(errors, "native prompt fixture handler failed");
  }
};
