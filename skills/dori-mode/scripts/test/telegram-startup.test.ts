import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-inbound-state.ts";
import { withState } from "./fakes.ts";

const token = "test-startup-token-not-for-network";
const legacyOffset = "1000";
const botId = 222;
type Request = { method: string; params: Record<string, unknown> };

const startup = async (
  scenario: Record<string, unknown> = {},
  args: readonly string[] = ["inbound", "telegram"],
  environment: Record<string, string | undefined> = {},
  seedCursor = false,
) => {
  const state = withState();
  const stateDir = process.platform === "win32" ? realpathSync(state.dir) : state.dir;
  if (process.platform === "win32") {
    const command =
      '$ErrorActionPreference="Stop";$p=$env:DORI_FIXTURE_STATE;$u=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=Get-Acl -LiteralPath $p;$a.SetOwner($u);$a.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;$($u.Value))",[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $p -AclObject $a';
    const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, DORI_FIXTURE_STATE: stateDir },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  const journal = join(state.dir, "requests.jsonl");
  const offset = join(state.dir, "telegram-offset");
  const config = join(state.dir, "config.json");
  writeFileSync(offset, legacyOffset);
  if (scenario["invalidCursorDirectory"] === true) writeFileSync(join(state.dir, "telegram-inbound"), "fixture");
  const cursorDir = join(state.dir, "telegram-inbound");
  const cursor = join(cursorDir, `${botId}.json`);
  if (seedCursor) {
    using store = fileTgInboundStore(stateDir, botId);
    store.save({ offset: 17, observedAt: Date.now(), seen: [] });
  }
  const cursorBefore = seedCursor ? readFileSync(cursor, "utf8") : undefined;
  writeFileSync(join(state.dir, "telegram-lag.jsonl"), '{"lagMs":12}\n');
  writeFileSync(config, JSON.stringify({ stateDir, defaultCwd: stateDir }));
  const cursorDirectoryMode = scenario["cursorDirectoryMode"];
  if (typeof cursorDirectoryMode === "number") chmodSync(cursorDir, cursorDirectoryMode);
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "record-telegram-startup.ts"),
      join(import.meta.dir, "../src/cli.ts"),
      ...args,
    ],
    {
      cwd: state.dir,
      env: {
        HOME: state.dir,
        PATH: "/usr/bin:/bin",
        DORI_CONFIG: config,
        DORI_STATE_DIR: stateDir,
        DORI_TELEGRAM_TOKEN: token,
        DORI_TELEGRAM_OWNER_ID: "7",
        DORI_TEST_TELEGRAM_REQUESTS: journal,
        DORI_TEST_TELEGRAM_STARTUP: JSON.stringify({
          identity: { id: botId, is_bot: true },
          webhook: { url: "" },
          ...scenario,
        }),
        ...environment,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    },
  );
  try {
    const error = new Response(child.stderr).text();
    const decoder = new TextDecoder();
    let out = "";
    let held = "";
    if (scenario["hold"] === undefined) child.stdin.end();
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk, { stream: true });
      if (!held && scenario["hold"] !== undefined && out.includes(`STARTUP_WAIT ${scenario["hold"]}\n`)) {
        held = out;
        if (scenario["release"] === true) {
          child.stdin.write("continue\n");
          child.stdin.end();
        } else child.kill("SIGTERM");
      }
    }
    out += decoder.decode();
    const [code, err] = await Promise.all([child.exited, error]);
    const requests: Request[] = existsSync(journal)
      ? readFileSync(journal, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Request)
      : [];
    return {
      code,
      out,
      err,
      held,
      requests,
      methods: requests.map((r) => r.method),
      legacyOffset: readFileSync(offset, "utf8"),
      cursorBefore,
      cursorAfter: seedCursor ? readFileSync(cursor, "utf8") : undefined,
    };
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    if (typeof cursorDirectoryMode === "number") chmodSync(cursorDir, 0o700);
    state.done();
  }
};

const posix = test.skipIf(process.platform === "win32");

test("Telegram inbound authenticates and checks an empty webhook before READY and the first poll", async () => {
  const r = await startup({}, undefined, {}, true);
  expect([r.code, r.err, r.methods]).toEqual([0, "", ["getMe", "getWebhookInfo", "getUpdates"]]);
  expect(r.requests[0]?.params).toEqual({});
  expect(r.requests[1]?.params).toEqual({});
  expect(r.requests[2]?.params["offset"]).toBe(17);
  expect(r.cursorAfter).toBe(r.cursorBefore);
  expect(r.out.split("\n").filter((line) => /^(STARTUP_|INBOUND_READY )/.test(line))).toEqual([
    "STARTUP_REQUEST getMe",
    "STARTUP_RESPONSE getMe",
    "STARTUP_REQUEST getWebhookInfo",
    "STARTUP_RESPONSE getWebhookInfo",
    "INBOUND_READY telegram owner=7 group=- topic=-",
    "STARTUP_REQUEST getUpdates",
    "STARTUP_RESPONSE getUpdates",
  ]);
  expect(r.legacyOffset).toBe(legacyOffset);
});

test("an active webhook exits even in loop mode without polling, ACK, readiness or webhook mutation", async () => {
  const r = await startup({ webhook: { url: "https://private-webhook.invalid/key", pending_update_count: 0 } }, [
    "inbound",
    "telegram",
    "--loop",
    "1",
  ]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("active webhook");
  expect(r.err).not.toContain("private-webhook");
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.methods).toEqual(["getMe", "getWebhookInfo"]);
  expect(r.legacyOffset).toBe(legacyOffset);
}, 10_000);

test("an unusable cursor directory fails startup before readiness or polling", async () => {
  const r = await startup({ invalidCursorDirectory: true });
  expect(r.code).toBe(1);
  const reason = process.platform === "win32" ? "object could not be opened privately" : "directory must be private";
  expect(r.err).toContain(`Telegram inbound cursor ${reason}`);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.methods).toEqual(["getMe", "getWebhookInfo"]);
  expect(r.legacyOffset).toBe(legacyOffset);
});

// POSIX-only: exercise real mode bits on a cursor directory the receiver owns.
posix.each([0o500, 0o300])("a cursor directory missing access (mode %i) fails before polling", async (mode) => {
  const r = await startup({ cursorDirectoryMode: mode }, undefined, {}, true);
  expect([r.code, r.methods]).toEqual([1, ["getMe", "getWebhookInfo"]]);
  expect(r.err).toContain("Telegram inbound cursor directory must allow owner read, write, search and sync");
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.cursorAfter).toBe(r.cursorBefore);
  expect(r.legacyOffset).toBe(legacyOffset);
});

test.each([
  null,
  {},
  { id: 0, is_bot: true },
  { id: -1, is_bot: true },
  { id: "222", is_bot: true },
  { id: Number.MAX_SAFE_INTEGER + 1, is_bot: true },
  { id: 222, is_bot: false },
])("an invalid authenticated bot identity fails closed: %j", async (identity) => {
  const r = await startup({ identity });
  expect(r.code).toBe(1);
  expect(r.err).toContain("bot identity");
  expect(r.methods).toEqual(["getMe"]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.legacyOffset).toBe(legacyOffset);
});

test.each([null, {}, { url: null }, { url: 0 }])("an invalid webhook status fails closed: %j", async (webhook) => {
  const r = await startup({ webhook });
  expect(r.code).toBe(1);
  expect(r.err).toContain("webhook status");
  expect(r.methods).toEqual(["getMe", "getWebhookInfo"]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.legacyOffset).toBe(legacyOffset);
});

test.each(["getMe", "getWebhookInfo"])(
  "a rejected %s startup request never polls or exposes API secrets",
  async (method) => {
    for (const mode of ["failure", "reject"]) {
      const r = await startup({ [mode]: method });
      expect(r.code).toBe(1);
      expect(r.methods).toEqual(method === "getMe" ? ["getMe"] : ["getMe", "getWebhookInfo"]);
      expect(r.err).not.toContain(token);
      expect(r.err).not.toContain("private-webhook");
      expect(r.out).not.toContain("INBOUND_READY");
      expect(r.legacyOffset).toBe(legacyOffset);
    }
  },
);
test.each(["getMe", "getWebhookInfo"])("READY and polling remain closed while %s is pending", async (hold) => {
  const r = await startup({ hold, release: true });
  expect(r.held).toContain(`STARTUP_WAIT ${hold}`);
  expect(r.held).not.toContain("INBOUND_READY");
  expect(r.held).not.toContain("STARTUP_REQUEST getUpdates");
  expect([r.code, r.methods]).toEqual([0, ["getMe", "getWebhookInfo", "getUpdates"]]);
  expect(r.out).toContain("INBOUND_READY telegram");
});
test.each(["getMe", "getWebhookInfo"])("stopping a pending %s startup never starts polling or ACK", async (hold) => {
  const r = await startup({ hold });
  expect(r.held).toContain(`STARTUP_WAIT ${hold}`);
  expect(r.code).not.toBe(0);
  expect(r.methods).toEqual(hold === "getMe" ? ["getMe"] : ["getMe", "getWebhookInfo"]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.legacyOffset).toBe(legacyOffset);
});

test("invalid local configuration is refused before even the startup read requests", async () => {
  const r = await startup({}, undefined, { DORI_TELEGRAM_OWNER_ID: "not-an-integer" });
  expect(r.code).toBe(1);
  expect(r.methods).toEqual([]);
  expect(r.out).not.toContain("INBOUND_READY");
});

test.each([["--version"], ["inbound-lag"]])("an offline command never activates Telegram: %j", async (command) => {
  const r = await startup({}, [command]);
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
  if (command === "inbound-lag") expect(r.out).toContain("LAG n=1");
  expect(r.methods).toEqual([]);
  expect(r.out).not.toContain("INBOUND_READY");
  expect(r.legacyOffset).toBe(legacyOffset);
});
