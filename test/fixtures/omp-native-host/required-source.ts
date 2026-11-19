import assert from "node:assert/strict";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import { nativeExtensionFactory } from "./compose.ts";

type FixtureModel = NonNullable<ExtensionContext["model"]>;

/** Native settings every fixture session here runs with: no compaction, retries, widgets or prewalk. */
export const NATIVE_FIXTURE_OVERRIDES = {
  "compaction.enabled": false,
  "async.widgets": false,
  "retry.enabled": false,
  "retry.modelFallback": false,
  "prewalk.auto": "off",
  "prewalk.enabled": false,
};

/** One local OpenAI-compatible provider answering every request "OK"; it records each request's model id in order. */
export function loopbackProvider(onRequest?: (modelId: string) => void) {
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json().catch(() => null);
      const modelId = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? body.model : "";
      requested.push(modelId);
      onRequest?.(modelId);
      return new Response(
        'data: {"id":"local","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n' +
          'data: {"id":"local","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const model = (id: string, reasoning = false) => ({
    id,
    name: "Local transport fixture",
    api: "openai-completions",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    reasoning,
    ...(reasoning ? { thinking: {
      mode: "effort",
      efforts: ["low", "medium", "high"].map((level) => {
        const effort = cfgDefaultThinkingLevel.get(Settings.isolated({ defaultThinkingLevel: level }));
        if (effort === "auto") throw new Error("native reasoning fixture requires a concrete effort");
        return effort;
      }),
    } satisfies NonNullable<FixtureModel["thinking"]> } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 1024,
    identity: { class: "unknown" },
    compat: undefined,
  }) satisfies FixtureModel;
  return { server, requested, model };
}

/** A native auth store and model registry that reach only `models` on the loopback provider, never a catalog. */
export async function loopbackRegistry(
  cwd: string,
  settings: Settings,
  models: readonly ReturnType<ReturnType<typeof loopbackProvider>["model"]>[],
) {
  const auth = await AuthStorage.create(join(cwd, "empty-auth.db"));
  auth.keys.setRuntime("openai", "local-fixture-only");
  const registry = new ModelRegistry(auth, join(cwd, "models.yml"), {
    settings,
    cacheDbPath: join(cwd, "models.db"),
    fetch: async () => {
      throw new Error("Native source regression prohibits external catalog access");
    },
  });
  const [first] = models;
  if (first)
    registry.registerProvider(first.provider, {
      api: first.api, baseUrl: first.baseUrl, apiKey: "local-fixture-only", models: [...models],
    });
  return { auth, registry };
}

/** Real native runner and provider transport; no external provider or credentials. */
export async function requiredSourceRequest(
  entry: string,
  cwd: string,
  role: "lane" | "dori" | undefined,
  boundary: "session" | "provider",
  launchModel?: string,
  profile?: {
    file: string;
    persistentSession?: boolean;
    alternateModelId?: string;
    reasoning?: boolean;
    beforeRequest(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): Promise<void>;
  },
): Promise<{ requests: number; errors: Array<{ event: string; error: string }>; modelSnapshot?: unknown }> {
  const factory = await nativeExtensionFactory(entry);
  const { server, requested, model: loopbackModel } = loopbackProvider();
  const model = loopbackModel("required-source-local", profile?.reasoning);
  const overrides = { ...NATIVE_FIXTURE_OVERRIDES };
  const settings = profile
    ? await Settings.loadIsolated({ cwd, agentDir: join(cwd, "agent"), configFiles: [profile.file], overrides })
    : Settings.isolated(overrides);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const errors: Array<{ event: string; error: string }> = [];
  try {
    const { auth, registry } = await loopbackRegistry(
      cwd,
      settings,
      launchModel ? [model, ...(profile?.alternateModelId ? [loopbackModel(profile.alternateModelId)] : [])] : [],
    );
    const manager = profile?.persistentSession ? SessionManager.create(cwd, join(cwd, "sessions")) : SessionManager.inMemory(cwd);
    if (role && !profile) manager.appendCustomEntry("omp-dori:role", role);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      sessionManager: manager,
      authStorage: auth,
      modelRegistry: registry,
      model,
      settings,
      bindProcessState: false,
      cacheWarming: false,
      disableModelFallback: true,
      toolNames: [],
      disableExtensionDiscovery: true,
      extensions: [async (api) => factory(launchModel ? new Proxy(api, {
        get(target, key) {
          return key === "getFlag"
            ? (name: string) => name === "dori-launch-model" ? launchModel : profile && name === "dori-role" ? role : target.getFlag(name)
            : Reflect.get(target, key);
        },
      }) : api)],
      skills: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      getApiKey: async (selected) => {
        assert.equal(selected.baseUrl, model.baseUrl);
        return "local-fixture-only";
      },
      assertDispatchModel: (selected) => assert.equal(selected.baseUrl, model.baseUrl),
    }));
    assert(session.extensionRunner);
    await initializeExtensions(session, {
      mode: "json",
      reportRuntimeError: (error) => errors.push({ event: error.event, error: error.error }),
      reportSendError: (_action, error) => {
        throw error;
      },
    });
    await profile?.beforeRequest(session);
    if (boundary === "session") await session.prompt("Return OK.");
    else await session.agent.prompt({ role: "user", content: "Return OK.", timestamp: Date.now() });
    const saved = manager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "omp-dori:model-snapshot");
    return { requests: requested.length, errors, modelSnapshot: saved?.type === "custom" ? saved.data : undefined };
  } finally {
    await session?.dispose();
    settings.stopWatching();
    await settings.flush();
    server.stop(true);
  }
}
