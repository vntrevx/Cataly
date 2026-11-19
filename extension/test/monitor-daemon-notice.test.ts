import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["silence", "restart"])(
  "%s operational notices stay bounded even when the output store fails",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "dori-daemon-notice-"));
    const program = `
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const { Monitors } = await import(${JSON.stringify(join(import.meta.dir, "../monitor.ts"))});
    const root = ${JSON.stringify(root)};
    const scenario = ${JSON.stringify(scenario)};
    const name = 'n'.repeat(70 * 1024);
    const messages = [];
    const monitors = new Monitors(text => messages.push(text), () => 'owner', 1);
    let fatal;
    process.once('uncaughtException', error => { fatal = error; process.exitCode = 1; monitors.stopAll(); console.error(error); });
    const until = async ready => { const end = Date.now() + 2000; while (!ready()) { assert(Date.now() < end); await Bun.sleep(5); } };
    try {
      if (scenario === 'silence') {
        process.env.TMPDIR = root + '/missing/output';
        monitors.start(name, ['sleep', '3'], '.', root, 'owner', { silentAfterMin: 0.001 });
        await Bun.sleep(150);
        assert.equal(fatal, undefined);
        assert(messages.some(text => text.includes('MONITOR_SILENT')));
      } else {
        const marker = root + '/runs';
        const child = "const fs = require('node:fs'); const marker = " + JSON.stringify(marker) + "; const second = fs.existsSync(marker); fs.appendFileSync(marker, 'run'); if (second) await Bun.sleep(3000); else process.exit(7);";
        monitors.start(name, [process.execPath, '-e', child], '.', root, 'owner', { mode: 'daemon', restart: { max: 1, backoffSec: 0.2 } });
        await until(() => messages.length > 0);
        process.env.TMPDIR = root + '/missing/output';
        await Bun.sleep(300);
        assert.equal(fatal, undefined);
        assert(messages.some(text => text.includes('restarted')));
        assert.equal(fs.readFileSync(marker, 'utf8'), 'runrun');
        assert(!messages.some(text => text.includes('restart failed')));
      }
      assert.equal(monitors.list().length, 1);
      assert(messages.every(text => Buffer.byteLength(text) <= 64 * 1024));
      console.log('NOTICE_PASS');
    } finally { monitors.stopAll(); }
  `;
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", program], {
        cwd: root,
        env: { ...process.env, TMPDIR: root },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("NOTICE_PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
