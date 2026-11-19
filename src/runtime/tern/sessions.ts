import type { Exec } from "../exec.ts";
import type { CreateSpec, SessionInfo, SessionRef } from "../types.ts";
import { findSession, idOf, layout, type TernLayout } from "./blocks.ts";
import { isMissing, ternCall } from "./exec.ts";
import { probeBlock } from "./probe.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The session a tab opens in when the spec names no group and the caller runs in no Tern block. */
const DEFAULT_SESSION = "dori";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCK_ID = /^[0-9]+$/;
/**
 * omp in a Tern pane draws its UI natively (Tern Surface Protocol), which `tern capture` cannot show, so Dori could
 * never read its screen. Every session Dori opens starts with the classic renderer; a spec env may still override it.
 */
const CLASSIC_UI = { PI_TUI_NATIVE: "0" };

/** The id of the Tern session holding the caller's own block (`TERN_PANE`), else `fallback`. */
export async function ownSession(exec: Exec, env: Env, fallback: string): Promise<string> {
  const own = selfRef(env);
  if (own === undefined) return fallback;
  return (await layout(exec)).blocks.find((b) => b.id === own.id)?.sessionId ?? fallback;
}

/** `--cwd DIR -- env K=V... SHELL`: Tern runs the argv through a shell with every element quoted. */
function launchArgv(spec: CreateSpec, shell: string): string[] {
  for (const key of Object.keys(spec.env))
    if (!ENV_KEY.test(key)) throw new Error(`env key ${JSON.stringify(key)} is not a shell variable name`);
  const env = { ...CLASSIC_UI, ...spec.env };
  return ["--cwd", spec.cwd, "--", "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), shell];
}

/** `name`, or `name-2`, `name-3`, ... : the first no session holds (`tern new session` refuses a taken name). */
const freeName = (l: TernLayout, name: string): string => {
  const taken = new Set(l.sessions.map((s) => s.name));
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`;
  return candidate;
};

/**
 * A block running the user's shell with the env set, nothing started. "workspace-root": a new session named after the
 * spec; "split-below": a split below `near`; "tab": a new tab, named after the spec, in `spec.group` (a session name
 * or id), else in the caller's own session, else in DEFAULT_SESSION. A session name nothing holds yet is opened with
 * the tab. The ref's group is the session id, its container the tab id.
 */
export async function create(exec: Exec, spec: CreateSpec, env: Env): Promise<SessionRef> {
  const launch = launchArgv(spec, env["SHELL"] || "sh");
  let argv: string[];
  if (spec.container === "split-below") {
    if (spec.near === undefined) throw new Error("a split-below session needs `near`");
    argv = ["split", spec.near.id, "down", ...launch];
  } else if (spec.container === "workspace-root") {
    argv = ["new", "session", freeName(await layout(exec), spec.name), ...launch];
  } else {
    const target = spec.group || (await ownSession(exec, env, DEFAULT_SESSION));
    const session = findSession(await layout(exec), target);
    if (session === undefined && BLOCK_ID.test(target)) throw new Error(`tern has no session ${target}`);
    argv = session === undefined ? ["new", "session", target, ...launch] : ["new", "tab", session.id, ...launch];
  }
  const result = await ternCall(exec, argv);
  const [id, group, container] = [idOf(result["block"]), idOf(result["session"]), idOf(result["tab"])];
  if (id === undefined) throw new Error(`tern ${argv[0]} did not return a block id`);
  const ref: SessionRef = {
    runtime: "tern",
    id,
    ...(group === undefined ? {} : { group }),
    ...(container === undefined ? {} : { container }),
  };
  if (spec.container === "tab") await nameTab(exec, ref, spec.name);
  return ref;
}

/** Names the new tab after its session (`tern rename` takes no `--`); a tab that cannot be named is closed again. */
async function nameTab(exec: Exec, ref: SessionRef, name: string): Promise<void> {
  try {
    await ternCall(exec, ["rename", ref.id, name]);
  } catch (e) {
    await close(exec, ref.id).catch(() => undefined);
    throw e;
  }
}

/** Types the command and Enter into the block's shell: a shell reports no status, so there is no gate. */
export async function start(exec: Exec, id: string, command: string): Promise<void> {
  await ternCall(exec, ["run", id, "--", command]);
}

/**
 * The live terminal blocks of one Tern session (`group`, a name or an id), or of every session of the window. Each is
 * probed for its foreground, so the status names a shell apart from an agent.
 */
export async function list(exec: Exec, group: string | undefined): Promise<SessionInfo[]> {
  const l = await layout(exec);
  const session = group === undefined ? undefined : findSession(l, group);
  if (group !== undefined && session === undefined) return [];
  const out: SessionInfo[] = [];
  for (const block of l.blocks) {
    if ((session !== undefined && block.sessionId !== session.id) || !block.live) continue;
    const seen = await probeBlock(exec, block);
    if (seen.status === "gone") continue;
    out.push({
      ref: { runtime: "tern", id: block.id, group: block.sessionId, container: block.tabId },
      ...(block.tabName === undefined ? {} : { name: block.tabName }),
      ...(block.title === undefined ? {} : { title: block.title }),
      ...(block.cwd === undefined ? {} : { cwd: block.cwd }),
      status: seen.status,
      ...(seen.agent === undefined ? {} : { agent: seen.agent }),
    });
  }
  return out;
}

/** `tern close`: the block's program ends with it. A block Tern no longer has is already closed. */
export async function close(exec: Exec, id: string): Promise<void> {
  try {
    await ternCall(exec, ["close", id]);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}

/** The block this process runs in, from the `TERN_PANE` Tern sets in every pane. */
export function selfRef(env: Env): SessionRef | undefined {
  const id = env["TERN_PANE"];
  return id !== undefined && BLOCK_ID.test(id) ? { runtime: "tern", id } : undefined;
}
