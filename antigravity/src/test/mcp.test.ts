import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..");

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MCP server stdio handshake", () => {
  it("responds to initialize, tools/list, and tools/call (cataly_boot)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cataly-mcp-"));
    tempDirs.push(home);

    const serverScript = join(distDir, "mcp-server.js");
    const child = spawn(process.execPath, [serverScript], {
      env: { ...process.env, CATALY_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const responses = new Map<number, unknown>();
    const waiters = new Map<number, (val: unknown) => void>();

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          const waiter = waiters.get(msg.id);
          if (waiter) {
            waiters.delete(msg.id);
            waiter(msg);
          } else {
            responses.set(msg.id, msg);
          }
        }
      }
    });

    const rpc = (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 5000);
        const onMsg = (v: unknown) => {
          clearTimeout(timer);
          resolvePromise(v as Record<string, unknown>);
        };
        if (responses.has(id)) {
          onMsg(responses.get(id));
        } else {
          waiters.set(id, onMsg);
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    try {
      const initRes = await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      assert.ok(initRes["result"], "initialize should return result");

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const listRes = (await rpc(2, "tools/list")) as { result?: { tools?: { name: string }[] } };
      const toolNames = (listRes.result?.tools ?? []).map((t) => t.name);
      assert.ok(toolNames.includes("cataly_boot"));
      assert.ok(toolNames.includes("cataly_lane_create"));
      assert.ok(toolNames.includes("cataly_done_check"));
      assert.ok(toolNames.includes("cataly_board_post"));
      assert.ok(toolNames.includes("cataly_board_read"));
      assert.ok(toolNames.includes("cataly_discord_poll"));
      assert.ok(toolNames.includes("cataly_discord_send"));
      assert.ok(toolNames.length >= 42, `expected >=42 tools, got ${toolNames.length}`);

      const bootRes = (await rpc(3, "tools/call", { name: "cataly_boot", arguments: {} })) as {
        result?: { content?: { text?: string }[] };
      };
      assert.match(bootRes.result?.content?.[0]?.text ?? "", /CATALY BOOT/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolveClose) => {
          const timer = setTimeout(resolveClose, 2000);
          child.once("close", () => {
            clearTimeout(timer);
            resolveClose();
          });
          try {
            child.stdin.end();
          } catch {
            // ignore
          }
          child.kill();
        });
      }
    }
  });
});
