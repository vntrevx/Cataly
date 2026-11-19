import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboundActivity, readInboundActivity } from "../src/update/source-activity.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-inbound-activity-"));
  const path = join(root, "discord.json");
  let at = 1000;
  const writer = inboundActivity(path, "discord", () => at)!;
  return {
    root,
    path,
    writer,
    at: (value: number) => {
      at = value;
    },
    close: () => {
      writer.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("activity is opt-in and a new receiver cannot inherit the previous writer's quiet time", () => {
  expect(inboundActivity(undefined, "discord")).toBeUndefined();
  expect(() => inboundActivity("relative.json", "discord")).toThrow("absolute");
  const f = fixture();
  try {
    expect(readInboundActivity(f.path)).toMatchObject({ available: false, quietSince: 1000, healthyAt: 0 });
    f.writer.healthy();
    expect(readFileSync(f.path + ".heartbeat", "utf8").trim()).toBe("1000");
    expect(readInboundActivity(f.path).process.pid).toBe(process.pid);
    expect(() => inboundActivity(f.path, "discord")).toThrow("lock is held");
    f.writer.close();
    expect(() => readInboundActivity(f.path)).toThrow();
    const next = inboundActivity(f.path, "discord", () => 9000)!;
    try {
      expect(readInboundActivity(f.path).quietSince).toBe(9000);
    } finally {
      next.close();
    }
  } finally {
    f.close();
  }
});

test("heartbeats preserve proven quiet but unavailable recovery starts a new quiet window", () => {
  const f = fixture();
  try {
    f.writer.healthy();
    f.at(2000);
    f.writer.received();
    f.at(3000);
    f.writer.healthy();
    expect(readInboundActivity(f.path)).toMatchObject({ available: true, quietSince: 2000, healthyAt: 3000 });
    f.at(4000);
    f.writer.unavailable();
    expect(readInboundActivity(f.path)).toMatchObject({ available: false, quietSince: 2000 });
    f.at(5000);
    f.writer.healthy();
    expect(readInboundActivity(f.path)).toMatchObject({ available: true, quietSince: 5000, healthyAt: 5000 });
    expect(Object.keys(JSON.parse(readFileSync(f.path, "utf8"))).sort()).toEqual([
      "available",
      "healthyAt",
      "platform",
      "process",
      "quietSince",
      "updatedAt",
      "version",
    ]);
  } finally {
    f.close();
  }
});

test("initial connection time cannot count as observed quiet", () => {
  const f = fixture();
  try {
    f.at(2_000_000);
    f.writer.healthy();
    expect(readInboundActivity(f.path)).toMatchObject({ available: true, quietSince: 2_000_000 });
  } finally {
    f.close();
  }
});

test("a changed PID incarnation cannot vouch for a quiet receiver", () => {
  const f = fixture();
  try {
    const value = JSON.parse(readFileSync(f.path, "utf8"));
    value.process.startTicks = "0";
    writeFileSync(f.path, JSON.stringify(value));
    expect(() => readInboundActivity(f.path)).toThrow("no longer current");
  } finally {
    f.close();
  }
});

test("a failed owner receipt invalidates the lease instead of leaving fresh-looking quiet state", () => {
  const f = fixture();
  try {
    f.writer.healthy();
    const before = readFileSync(f.path, "utf8");
    chmodSync(f.path, 0o666);
    expect(() => f.writer.received()).toThrow("protected");
    expect(readFileSync(f.path, "utf8")).toBe(before);
    chmodSync(f.path, 0o600);
    expect(() => readInboundActivity(f.path)).toThrow();
    expect(() => f.writer.healthy()).toThrow("closed");
  } finally {
    f.close();
  }
});

test("a foreign heartbeat link is not followed and cannot publish healthy activity", () => {
  const f = fixture();
  try {
    const target = join(f.root, "untouched");
    writeFileSync(target, "preserve", { mode: 0o600 });
    symlinkSync(target, f.path + ".heartbeat");
    expect(() => f.writer.healthy()).toThrow("protected");
    expect(readFileSync(target, "utf8")).toBe("preserve");
    expect(JSON.parse(readFileSync(f.path, "utf8")).available).toBe(false);
    expect(() => readInboundActivity(f.path)).toThrow();
  } finally {
    f.close();
  }
});
