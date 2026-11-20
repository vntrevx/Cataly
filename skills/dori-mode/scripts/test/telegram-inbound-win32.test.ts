import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileTgInboundStore } from "../src/messenger/telegram-inbound-state.ts";
import { withState } from "./fakes.ts";

const windows = test.skipIf(process.platform !== "win32");
const bot = 900;
const first = { offset: 14, observedAt: 100, seen: ["a".repeat(64)] };
const next = { offset: 15, observedAt: 101, seen: ["b".repeat(64)] };
const windowsSecurity = (path: string, script: string): string => {
  const prefix = [
    '$ErrorActionPreference = "Stop"',
    "$p = $env:DORI_CURSOR_TEST_PATH",
    "$sidType = [Security.Principal.SecurityIdentifier]",
    "$u = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$s = $u.Value",
    "$a = Get-Acl -LiteralPath $p",
  ];
  const result = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", [...prefix, script].join(";")],
    { env: { ...process.env, DORI_CURSOR_TEST_PATH: path } },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const setFixtureAcl = (path: string, extraAce = "") =>
  windowsSecurity(
    path,
    '$a.SetOwner($u);$a.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;${s})' +
      extraAce +
      '",[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $p -AclObject $a',
  );
const fixture = () => {
  const root = withState();
  const state = join(realpathSync(root.dir), "state");
  try {
    mkdirSync(state);
    setFixtureAcl(state);
    const directory = join(state, "telegram-inbound");
    return { root, state, directory, cursor: join(directory, `${bot}.json`) };
  } catch (error) {
    root.done();
    throw error;
  }
};
const seed = (state: string) => {
  using store = fileTgInboundStore(state, bot);
  store.save(first);
};

const inspectAcl = (path: string) =>
  windowsSecurity(
    path,
    [
      "$r = @($a.GetAccessRules($true, $true, $sidType))",
      "[PSCustomObject]@{ ownerMatches = ($a.GetOwner($sidType).Value -eq $s); protected = $a.AreAccessRulesProtected;",
      "rules = @($r | ForEach-Object { [PSCustomObject]@{ sameUser = ($_.IdentityReference.Value -eq $s);",
      "rights = [int]$_.FileSystemRights; inherited = $_.IsInherited; type = $_.AccessControlType.ToString() } }) }",
      "| ConvertTo-Json -Depth 4 -Compress",
    ].join(" "),
  );

windows("NTFS preflight keeps the cursor and replacements reopen with a private owner DACL", () => {
  const f = fixture();
  try {
    seed(f.state);
    const original = statSync(f.cursor, { bigint: true }).ino;
    expect(original > 0n).toBe(true);
    const bytes = readFileSync(f.cursor, "utf8");
    {
      using store = fileTgInboundStore(f.state, bot);
      store.checkWritable();
      expect(store.load()).toEqual(first);
      expect(statSync(f.cursor, { bigint: true }).ino).toBe(original);
      expect(readFileSync(f.cursor, "utf8")).toBe(bytes);
      store.save(next);
    }
    using reopened = fileTgInboundStore(f.state, bot);
    expect(reopened.load()).toEqual(next);
    expect(statSync(f.cursor, { bigint: true }).ino).not.toBe(original);
    expect(JSON.parse(readFileSync(f.cursor, "utf8"))).toEqual({ version: 1, botId: bot, ...next });
    expect(readdirSync(f.directory).sort()).toEqual([`${bot}.json`, `${bot}.lock`]);
    for (const path of [f.directory, f.cursor]) {
      expect(JSON.parse(inspectAcl(path))).toEqual({
        ownerMatches: true,
        protected: true,
        rules: [{ sameUser: true, rights: 0x1f01ff, inherited: false, type: "Allow" }],
      });
    }
  } finally {
    f.root.done();
  }
});

windows("an NTFS junction in the configured ancestor chain is rejected without creating an outside cursor", () => {
  const f = fixture();
  try {
    const alias = join(realpathSync(f.root.dir), "alias");
    symlinkSync(f.state, alias, "junction");
    expect(() => fileTgInboundStore(alias, bot)).toThrow("Telegram inbound cursor encountered a reparse point");
    expect(existsSync(f.directory)).toBe(false);
  } finally {
    f.root.done();
  }
});

windows("an NTFS junction at the cursor directory is rejected without touching outside bytes", () => {
  const f = fixture();
  try {
    const outside = join(f.root.dir, "out");
    mkdirSync(outside);
    const canary = join(outside, `${bot}.json`);
    writeFileSync(canary, "outside");
    symlinkSync(outside, f.directory, "junction");
    expect(() => fileTgInboundStore(f.state, bot)).toThrow("Telegram inbound cursor encountered a reparse point");
    expect(readFileSync(canary, "utf8")).toBe("outside");
    expect(readdirSync(outside)).toEqual([`${bot}.json`]);
  } finally {
    f.root.done();
  }
});

windows("an outside hard-link alias prevents reads and replacement of a cursor with an otherwise private ACL", () => {
  const f = fixture();
  try {
    seed(f.state);
    const alias = join(f.root.dir, "outside.json");
    linkSync(f.cursor, alias);
    const original = readFileSync(alias, "utf8");
    {
      using reader = fileTgInboundStore(f.state, bot);
      expect(() => reader.load()).toThrow("object is linked");
    }
    {
      using writer = fileTgInboundStore(f.state, bot);
      expect(() => writer.save(next)).toThrow("object is linked");
    }
    expect(readFileSync(alias, "utf8")).toBe(original);
    expect(readFileSync(f.cursor, "utf8")).toBe(original);
  } finally {
    f.root.done();
  }
});

windows("readiness rejects rather than repairing a protected cursor DACL that grants another SID access", () => {
  const f = fixture();
  try {
    seed(f.state);
    const original = readFileSync(f.cursor, "utf8");
    setFixtureAcl(f.cursor, "(A;;FR;;;WD)");
    {
      using store = fileTgInboundStore(f.state, bot);
      expect(() => store.checkWritable()).toThrow("must be private");
    }
    expect(readFileSync(f.cursor, "utf8")).toBe(original);
    expect(inspectAcl(f.cursor)).toContain('"sameUser":false');
  } finally {
    f.root.done();
  }
});

windows("another receiver cannot replace the cursor while this bot and state directory are leased", () => {
  const f = fixture();
  try {
    {
      using owner = fileTgInboundStore(f.state, bot);
      owner.save(first);
      using contender = fileTgInboundStore(f.state, bot);
      expect(() => contender.save(next)).toThrow("object could not be opened privately");
      expect(owner.load()).toEqual(first);
    }
    using reopened = fileTgInboundStore(f.state, bot);
    reopened.save(next);
    expect(reopened.load()).toEqual(next);
  } finally {
    f.root.done();
  }
});

windows(
  "CLI exits nonzero and releases the lease on cursor failure",
  async () => {
    const f = fixture();
    try {
      // An empty stubbed poll still saves to clear the seeded receipt.
      seed(f.state);
      const entry = join(import.meta.dir, "../src/cli.ts");
      const preload = join(import.meta.dir, "record-telegram-startup.ts");
      const child = Bun.spawn([process.execPath, "--preload", preload, entry, "inbound", "telegram"], {
        cwd: f.state,
        env: {
          HOME: f.state,
          DORI_CONFIG: join(f.state, "config.json"),
          DORI_STATE_DIR: f.state,
          DORI_TELEGRAM_TOKEN: "offline-fixture",
          DORI_TELEGRAM_OWNER_ID: "7",
          DORI_TEST_TELEGRAM_REQUESTS: join(f.state, "requests.jsonl"),
          DORI_TEST_TELEGRAM_STARTUP: JSON.stringify({
            identity: { id: bot, is_bot: true },
            webhook: { url: "" },
            hold: "getUpdates",
          }),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      try {
        const stderr = new Response(child.stderr).text();
        let stdout = "";
        let released = false;
        for await (const chunk of child.stdout) {
          stdout += Buffer.from(chunk).toString("utf8");
          if (!released && stdout.includes("STARTUP_WAIT getUpdates")) {
            setFixtureAcl(f.cursor, "(A;;FR;;;WD)");
            released = true;
            child.stdin.write("continue\n");
            child.stdin.end();
          }
        }
        expect(released).toBe(true);
        expect(await child.exited).toBe(1);
        expect(await stderr).toContain("Telegram inbound cursor directory must be private");
        expect(stdout).toContain("INBOUND_READY telegram");
        expect(stdout.match(/STARTUP_REQUEST getUpdates/g)).toEqual(["STARTUP_REQUEST getUpdates"]);
        setFixtureAcl(f.cursor);
        using reopened = fileTgInboundStore(f.state, bot);
        expect(reopened.load()).toEqual(first);
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    } finally {
      f.root.done();
    }
  },
  20_000,
);
