import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Signal =
  | { readonly kind: "merged" | "closed"; readonly repo: string; readonly n: string }
  | { readonly kind: "published"; readonly pkg: string; readonly version: string }
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly stdout?: RegExp }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly sha256?: string;
      readonly json?: { readonly path: readonly (string | number)[]; readonly value: unknown };
    }
  | { readonly kind: "url"; readonly url: string; readonly status: number; readonly body?: RegExp };

export type RunResult = {
  readonly code: number;
  readonly out: string;
  readonly err: string;
};

export type Runner = (
  argv: readonly string[],
  opts?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<RunResult>;

export type HttpFetcher = (req: {
  readonly method: string;
  readonly url: string;
}) => Promise<{ readonly status: number; readonly body: string }>;

export type SignalCheck = {
  readonly signal: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type SignalIo = {
  readonly http?: HttpFetcher;
  readonly cwd?: string;
  readonly home?: string;
};

export const COMMAND_TIMEOUT_MS = 120_000;

export const UNREADABLE_SIGNAL = [
  "unreadable signal; use one of:",
  "merged <owner/repo>#N | closed <owner/repo>#N | published <pkg>@<version>",
  'command ["argv","as","json"] [stdout~"regex"]',
  "file <path> [sha256=<hex>] [json:.a.b=<json value>]",
  'url <http(s) url> [status=200] [body~"regex"]',
].join(" ");

export class SignalSyntaxError extends Error {}

const readJsonToken = (s: string, i: number): { readonly value: unknown; readonly end: number } => {
  const open = s[i];
  let end = i;
  if (open === '"') {
    end++;
    while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
    end++;
  } else if (open === "[" || open === "{") {
    let depth = 0;
    for (; end < s.length; end++) {
      const c = s[end];
      if (c === '"') {
        end++;
        while (end < s.length && s[end] !== '"') end += s[end] === "\\" ? 2 : 1;
      } else if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && --depth === 0) break;
    }
    end++;
  } else {
    while (end < s.length && !/\s/.test(s[end] ?? "")) end++;
  }
  const text = s.slice(i, end);
  try {
    return { value: JSON.parse(text), end };
  } catch {
    if (open === '"' || open === "[" || open === "{") {
      throw new SignalSyntaxError(`not valid JSON at "${text.slice(0, 40)}"`);
    }
    return { value: text, end };
  }
};

export const splitDone = (done: string): string[] => {
  const body = done.replace(/^Done\s*=\s*/i, "");
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

type Opt = { readonly key: string; readonly op: "=" | "~"; readonly value: unknown };

const readOptions = (s: string, i: number): Opt[] => {
  const opts: Opt[] = [];
  while (i < s.length) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (i >= s.length) break;
    const m = /^([a-z0-9_]+(?::[^=~\s]+)?)([=~])/i.exec(s.slice(i));
    if (!m?.[1] || !m[2]) {
      throw new SignalSyntaxError(`expected key=value or key~"regex" at "${s.slice(i, i + 30)}"`);
    }
    i += m[0].length;
    const r = readJsonToken(s, i);
    opts.push({ key: m[1], op: m[2] as "=" | "~", value: r.value });
    i = r.end;
  }
  return opts;
};

const toRegex = (o: Opt | undefined, what: string): RegExp | undefined => {
  if (!o) return undefined;
  if (o.op !== "~" || typeof o.value !== "string") {
    throw new SignalSyntaxError(`${what} takes ~"regex"`);
  }
  try {
    return new RegExp(o.value);
  } catch {
    throw new SignalSyntaxError(`${what}: invalid regex ${o.value}`);
  }
};

const onlyKeys = (opts: readonly Opt[], allowed: (k: string) => boolean, kind: string): void => {
  const bad = opts.find((o) => !allowed(o.key));
  if (bad) throw new SignalSyntaxError(`${kind}: unknown option ${bad.key}`);
};

export const parseSignal = (raw: string): Signal => {
  const s = raw.trim();
  const gh = /^(merged|closed)\s+([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)(\d+)\s*$/i.exec(s);
  if (gh?.[1] && gh[2] && gh[3]) {
    return { kind: gh[1].toLowerCase() as "merged" | "closed", repo: gh[2], n: gh[3] };
  }
  const pub = /^published\s+(\S+)@(\S+)\s*$/i.exec(s);
  if (pub?.[1] && pub[2]) {
    return { kind: "published", pkg: pub[1], version: pub[2] };
  }
  const head = /^(command|file|url)\s+/i.exec(s);
  if (!head?.[1]) throw new SignalSyntaxError(UNREADABLE_SIGNAL);
  const kind = head[1].toLowerCase();
  const at = head[0].length;

  if (kind === "command") {
    if (s[at] !== "[") {
      throw new SignalSyntaxError('command takes a JSON argv array, e.g. command ["npm","test"]');
    }
    const { value, end } = readJsonToken(s, at);
    if (!Array.isArray(value) || !value.length || !value.every((a) => typeof a === "string" && a.length > 0)) {
      throw new SignalSyntaxError("command argv must be a non-empty array of non-empty strings");
    }
    const opts = readOptions(s, end);
    onlyKeys(opts, (k) => k === "stdout", "command");
    const stdout = toRegex(
      opts.find((o) => o.key === "stdout"),
      "stdout",
    );
    return { kind: "command", argv: value as string[], ...(stdout !== undefined ? { stdout } : {}) };
  }

  if (kind === "file") {
    const pathTok =
      s[at] === '"'
        ? readJsonToken(s, at)
        : { value: /^\S+/.exec(s.slice(at))?.[0] ?? "", end: at + (/^\S+/.exec(s.slice(at))?.[0].length ?? 0) };
    if (typeof pathTok.value !== "string" || !pathTok.value) {
      throw new SignalSyntaxError("file needs a path");
    }
    const opts = readOptions(s, pathTok.end);
    onlyKeys(opts, (k) => k === "sha256" || k.startsWith("json:"), "file");
    const sha = opts.find((o) => o.key === "sha256");
    if (sha && (sha.op !== "=" || typeof sha.value !== "string" || !/^[0-9a-f]{64}$/i.test(sha.value))) {
      throw new SignalSyntaxError("sha256= takes 64 hex characters");
    }
    const js = opts.find((o) => o.key.startsWith("json:"));
    if (js && js.op !== "=") throw new SignalSyntaxError("json:<path> takes =<json value>");
    const jsonPath = js
      ? js.key
          .slice(5)
          .replace(/^\./, "")
          .split(".")
          .filter(Boolean)
          .map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [];
    if (js && !jsonPath.length) {
      throw new SignalSyntaxError("json: needs a field path like json:.version");
    }
    return {
      kind: "file",
      path: pathTok.value,
      ...(sha ? { sha256: String(sha.value).toLowerCase() } : {}),
      ...(js ? { json: { path: jsonPath, value: js.value } } : {}),
    };
  }

  const urlTok = /^\S+/.exec(s.slice(at))?.[0] ?? "";
  if (!/^https?:\/\/\S+$/i.test(urlTok)) throw new SignalSyntaxError("url needs an http(s) URL");
  const opts = readOptions(s, at + urlTok.length);
  onlyKeys(opts, (k) => k === "status" || k === "body", "url");
  const st = opts.find((o) => o.key === "status");
  if (st && (st.op !== "=" || !Number.isInteger(st.value))) {
    throw new SignalSyntaxError("status= takes an integer");
  }
  const body = toRegex(
    opts.find((o) => o.key === "body"),
    "body",
  );
  return {
    kind: "url",
    url: urlTok,
    status: st ? Number(st.value) : 200,
    ...(body !== undefined ? { body } : {}),
  };
};

export const defaultRunner: Runner = (argv, opts = {}) =>
  new Promise<RunResult>((resolvePromise) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolvePromise({ code: 127, out: "", err: "empty command" });
      return;
    }
    // On Windows, .cmd/.bat shims like npm.cmd need shell resolution only when invoking npm directly;
    // to keep no-shell safety while supporting npm on Windows, resolve npm -> npm.cmd when win32.
    const resolvedCmd = process.platform === "win32" && (cmd === "npm" || cmd === "npx") ? `${cmd}.cmd` : cmd;

    execFile(
      resolvedCmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32" && resolvedCmd.endsWith(".cmd"),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ code: 0, out: String(stdout ?? ""), err: String(stderr ?? "") });
          return;
        }
        const errObj = error as NodeJS.ErrnoException & { code?: number | string };
        const code = typeof errObj.code === "number" ? errObj.code : 1;
        resolvePromise({
          code,
          out: String(stdout ?? ""),
          err: String(stderr ?? "") || error.message,
        });
      },
    );
  });

export const defaultHttpFetcher: HttpFetcher = async ({ method, url }) => {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, body: await res.text() };
};

const publishedVersions = (out: string): unknown[] => {
  try {
    return [JSON.parse(out)].flat();
  } catch {
    return [];
  }
};

const resolvePath = (p: string, io: SignalIo): string => {
  const home = io.home ?? homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : join(io.cwd ?? process.cwd(), expanded);
};

const dig = (v: unknown, path: readonly (string | number)[]): { readonly found: boolean; readonly value: unknown } => {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object" || !(k in (cur as object))) {
      return { found: false, value: undefined };
    }
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return { found: true, value: cur };
};

const short = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 120);

export const checkSignal = async (
  signal: string,
  run: Runner = defaultRunner,
  io: SignalIo = {},
): Promise<SignalCheck> => {
  const s = signal.trim();
  let sig: Signal;
  try {
    sig = parseSignal(s);
  } catch (e) {
    return { signal: s, ok: false, detail: e instanceof SignalSyntaxError ? e.message : String(e) };
  }

  switch (sig.kind) {
    case "merged": {
      const r = await run(["gh", "pr", "view", sig.n, "--repo", sig.repo, "--json", "state,mergeCommit"]);
      let j: { state?: string; mergeCommit?: { oid?: string } | null } = {};
      if (r.code === 0) {
        try {
          j = JSON.parse(r.out) as typeof j;
        } catch {
          return { signal: s, ok: false, detail: "unreadable gh response" };
        }
      }
      const sha = j.mergeCommit?.oid ?? "";
      return {
        signal: s,
        ok: j.state === "MERGED" && sha.length > 0,
        detail: j.state ? `${j.state} ${sha.slice(0, 10)}`.trim() : short(r.err) || "no answer",
      };
    }

    case "closed": {
      const r = await run(["gh", "issue", "view", sig.n, "--repo", sig.repo, "--json", "state"]);
      let j: { state?: string } = {};
      if (r.code === 0) {
        try {
          j = JSON.parse(r.out) as typeof j;
        } catch {
          return { signal: s, ok: false, detail: "unreadable gh response" };
        }
      }
      return { signal: s, ok: j.state === "CLOSED", detail: j.state ?? (short(r.err) || "no answer") };
    }

    case "published": {
      const r = await run(["npm", "view", `${sig.pkg}@${sig.version}`, "version", "--json"]);
      const ok = r.code === 0 && publishedVersions(r.out).includes(sig.version);
      return {
        signal: s,
        ok,
        detail: ok ? `registry has ${sig.pkg}@${sig.version}` : short(r.err || r.out) || "not published",
      };
    }

    case "command": {
      const r = await run(sig.argv, { ...(io.cwd ? { cwd: io.cwd } : {}), timeoutMs: COMMAND_TIMEOUT_MS });
      if (r.code !== 0) {
        return { signal: s, ok: false, detail: `exit ${r.code}: ${short(r.err || r.out) || "no output"}` };
      }
      if (sig.stdout && !sig.stdout.test(r.out)) {
        return {
          signal: s,
          ok: false,
          detail: `exit 0 but stdout does not match ${sig.stdout}: ${short(r.out) || "(empty)"}`,
        };
      }
      return { signal: s, ok: true, detail: sig.stdout ? `exit 0, stdout matches ${sig.stdout}` : "exit 0" };
    }

    case "file": {
      const filePath = resolvePath(sig.path, io);
      if (!existsSync(filePath)) return { signal: s, ok: false, detail: `missing: ${filePath}` };
      const buf = readFileSync(filePath);
      if (sig.sha256) {
        const got = createHash("sha256").update(buf).digest("hex");
        if (got !== sig.sha256) {
          return { signal: s, ok: false, detail: `sha256 ${got.slice(0, 12)}... != ${sig.sha256.slice(0, 12)}...` };
        }
      }
      if (sig.json) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(buf.toString("utf8"));
        } catch {
          return { signal: s, ok: false, detail: `not JSON: ${filePath}` };
        }
        const hit = dig(parsed, sig.json.path);
        const want = JSON.stringify(sig.json.value);
        if (!hit.found) return { signal: s, ok: false, detail: `no field .${sig.json.path.join(".")}` };
        if (JSON.stringify(hit.value) !== want) {
          return {
            signal: s,
            ok: false,
            detail: `.${sig.json.path.join(".")} is ${short(JSON.stringify(hit.value))}, want ${want}`,
          };
        }
      }
      return {
        signal: s,
        ok: true,
        detail: `present${sig.sha256 ? ", sha256 matches" : ""}${sig.json ? `, .${sig.json.path.join(".")} matches` : ""}`,
      };
    }

    case "url": {
      let res: { readonly status: number; readonly body: string };
      try {
        res = await (io.http ?? defaultHttpFetcher)({ method: "GET", url: sig.url });
      } catch (e) {
        return { signal: s, ok: false, detail: `request failed: ${short(String(e))}` };
      }
      if (res.status !== sig.status) {
        return { signal: s, ok: false, detail: `status ${res.status}, want ${sig.status}` };
      }
      if (sig.body && !sig.body.test(res.body)) {
        return { signal: s, ok: false, detail: `status ${res.status} but body does not match ${sig.body}` };
      }
      return { signal: s, ok: true, detail: `status ${res.status}${sig.body ? ", body matches" : ""}` };
    }
  }
};

export const checkDone = async (
  done: string,
  run: Runner = defaultRunner,
  io: SignalIo = {},
): Promise<SignalCheck[]> => {
  const parts = splitDone(done);
  if (!parts.length) return [{ signal: done, ok: false, detail: "empty Done line" }];
  return Promise.all(parts.map((p) => checkSignal(p, run, io)));
};

export const doneSyntaxErrors = (done: string): string[] => {
  const parts = splitDone(done);
  if (!parts.length) return ["(empty Done line)"];
  return parts.flatMap((p) => {
    try {
      parseSignal(p);
      return [];
    } catch (e) {
      return [`${p} -> ${e instanceof Error ? e.message : String(e)}`];
    }
  });
};
