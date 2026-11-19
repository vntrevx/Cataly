import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { requiredSourceRequest } from "../../test/fixtures/omp-native-host/required-source.ts";
import { dirname, join } from "node:path";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { calls, load, useConfig, type FakeOptions } from "./fake-pi.ts";

const exact = { provider: "subscription", id: "exact" };

for (const [name, options, status] of [
  ["exact subscribed model", { model: exact, subscription: true }, "matched"],
  ["literal colon-tagged id", { model: { ...exact, id: "exact:14b" }, selector: "subscription/exact:14b" }, "matched"],
  ["native case-insensitive exact identity", { model: exact, selector: "Subscription/EXACT" }, "matched"],
  [
    "different literal id with a case collision",
    { model: exact, selector: "subscription/Exact", catalog: [{ ...exact, id: "Exact" }, exact] },
    "mismatch",
  ],
  [
    "ambiguous case-insensitive id",
    { model: exact, selector: "subscription/EXACT", catalog: [{ ...exact, id: "Exact" }, exact] },
    "unknown",
  ],
  [
    "original literal id wins over a case collision",
    { model: { ...exact, id: "Exact" }, selector: "Subscription/Exact", catalog: [{ ...exact, id: "Exact" }, exact] },
    "matched",
  ],
  ["same id on another provider", { model: { ...exact, provider: "metered" }, catalog: [exact] }, "mismatch"],
  ["similar id on requested provider", { model: { ...exact, id: "exact-new" }, catalog: [exact] }, "mismatch"],
  ["unavailable subscription model", { model: exact, catalog: [] }, "unavailable"],
  [
    "thinking suffix without a literal catalog id",
    { model: exact, selector: "subscription/exact:high" },
    "unavailable",
  ],
  ["unknown native selection", {}, "unknown"],
] as const) {
  test(`native launch guard: ${name}`, async () => {
    const keys = ["DORI_CONFIG", "DORI_STATE_DIR", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
    const previous = keys.map((key) => process.env[key]);
    const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
    process.env.HERDR_PANE_ID = "model:p1";
    delete process.env.HC_TERMINAL_ID;
    const selector = "selector" in options ? options.selector : "subscription/exact";
    const settings: FakeOptions = {
      session: { id: "model-session", entries: [] },
      flags: { "dori-role": "lane", "dori-launch-model": selector },
      ...("model" in options ? { model: options.model } : {}),
      ...("subscription" in options ? { subscription: options.subscription } : {}),
      ...("catalog" in options ? { catalog: [...options.catalog] } : {}),
    };
    const pi = await load(settings);
    try {
      await pi.emit("session_start");
      const readback = readPaneState(stateDir, "model:p1")?.modelReadback;
      expect(readback).toMatchObject({
        requested: { provider: selector.split("/")[0], id: selector.split("/").slice(1).join("/") },
        status,
        source: "native-extension",
      });
      expect(Number.isFinite(Date.parse(readback?.checkedAt ?? ""))).toBe(true);
      expect(readback?.billing).toBe(
        settings.model ? (settings.subscription ? "subscription" : "non-subscription") : "unknown",
      );
      for (const event of ["before_agent_start", "before_provider_request"]) {
        if (status === "matched") await pi.emit(event);
        else {
          const aborts = calls.filter((call) => call === "abort").length;
          await expect(pi.emit(event)).rejects.toThrow("STARTUP_MODEL_HOLD");
          expect(calls.filter((call) => call === "abort")).toHaveLength(aborts + 1);
        }
      }
      if (status === "matched") {
        settings.model = { ...exact, provider: "metered" };
        await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
      }
      expect(pi.userMessages).toEqual([]);
    } finally {
      await pi.emit("session_shutdown");
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(dirname(stateDir), { recursive: true, force: true });
    }
  });
}

for (const boundary of ["session", "provider"] as const) {
  test(`real native ${boundary} sends zero requests for an unavailable exact model`, async () => {
    const keys = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
    const previous = keys.map((key) => process.env[key]);
    const home = dirname(useConfig(""));
    process.env.HOME = home;
    delete process.env.DORI_OMP_ULW_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HC_TERMINAL_ID;
    try {
      for (const [selector, expected] of [
        ["openai/required-source-local", 1],
        ["openai/absent", 0],
      ] as const) {
        const cwd = join(home, String(expected));
        mkdirSync(cwd);
        const result = await requiredSourceRequest(
          join(import.meta.dir, "../index.ts"),
          cwd,
          "lane",
          boundary,
          selector,
        );
        expect(result.errors.filter((error) => error.event === "session_start")).toEqual([]);
        expect(result.requests).toBe(expected);
        if (expected === 0)
          expect(result.errors.some((error) => error.error.includes("STARTUP_MODEL_HOLD"))).toBe(true);
      }
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("the launch lock follows its initial session, not ordinary sessions opened in the same process", async () => {
  const settings: FakeOptions = {
    session: { id: "launch-target", entries: [] },
    flags: { "dori-role": "lane", "dori-launch-model": "subscription/exact" },
    model: exact,
  };
  const pi = await load(settings);
  await pi.emit("session_start");
  const initial = pi.session;
  await pi.emit("before_provider_request");
  pi.session = { id: "ordinary", entries: [] };
  settings.model = { provider: "fixture", id: "other" };
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  await pi.emit("before_agent_start");
  await pi.emit("before_provider_request");
  pi.session = initial;
  await pi.emit("session_switch", { type: "session_switch", reason: "resume" });
  await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
});

test("a new session carrying the lane role also carries its exact model lock", async () => {
  const settings: FakeOptions = {
    session: { id: "lane-before-new", entries: [] },
    flags: { "dori-role": "lane", "dori-launch-model": "subscription/exact" },
    model: exact,
  };
  const pi = await load(settings);
  await pi.emit("session_start");
  pi.session = { id: "lane-after-new", entries: [] };
  await pi.emit("session_switch", { type: "session_switch", reason: "new" });
  await pi.emit("before_provider_request");
  settings.model = { provider: "fixture", id: "other" };
  await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
});

test("the initial launch cannot escape its model guard through a missing lane role", async () => {
  const pi = await load({
    session: { id: "wrong-role", entries: [] },
    flags: { "dori-launch-model": "subscription/exact" },
    model: exact,
  });
  await pi.emit("session_start");
  await expect(pi.emit("before_provider_request")).rejects.toThrow("STARTUP_MODEL_HOLD");
});

test("native children keep their own models instead of inheriting the root launch lock", async () => {
  const pi = await load({
    session: { id: "child", entries: [] },
    flags: { "dori-role": "lane", "dori-launch-model": "subscription/exact" },
    agent: { kind: "sub", id: "model-child" },
    model: { provider: "fixture", id: "other" },
  });
  await pi.emit("session_start");
  await pi.emit("before_provider_request");
});
