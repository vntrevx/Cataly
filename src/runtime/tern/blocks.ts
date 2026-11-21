// One `tern inspect --json` read as the blocks Dori can address: sessions hold tabs, tabs hold blocks, and the
// `panes` list carries Tern's busy flag for each block's program.
import type { Exec } from "../exec.ts";
import { ternCall } from "./exec.ts";

export type TernBlock = {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly tabId: string;
  readonly tabName?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly cols?: number;
  /** A terminal whose program still runs (not a note or file block, not a block kept open after its exit). */
  readonly live: boolean;
  /** Tern's busy flag: the program's terminal progress (OSC 9;4), which omp sets for the length of a turn. */
  readonly working: boolean;
};
export type TernSession = { readonly id: string; readonly name: string };
export type TernLayout = { readonly sessions: readonly TernSession[]; readonly blocks: readonly TernBlock[] };

const recs = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v))
    : [];
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
export const idOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The sessions and blocks of one `tern inspect --json` answer; rows without a usable id are skipped. */
export function parseLayout(raw: Record<string, unknown>): TernLayout {
  const working = new Map<string, boolean>();
  for (const pane of recs(raw["panes"])) {
    const id = idOf(pane["pane"]);
    if (id !== undefined) working.set(id, pane["working"] === true);
  }
  const sessions: TernSession[] = [];
  const blocks: TernBlock[] = [];
  for (const s of recs(raw["sessions"])) {
    const [sessionId, sessionName] = [idOf(s["id"]), str(s["name"])];
    if (sessionId === undefined) continue;
    sessions.push({ id: sessionId, name: sessionName ?? sessionId });
    for (const tab of recs(s["tabs"])) {
      const [tabId, tabName] = [idOf(tab["id"]), str(tab["name"])];
      if (tabId === undefined) continue;
      for (const b of recs(tab["blocks"])) {
        const id = idOf(b["id"]);
        if (id === undefined) continue;
        const [title, cwd, cols] = [str(b["title"]), str(b["cwd"]), num(b["cols"])];
        // Tern prints a value it does not have as null: a terminal has a program and no file, a running one no exit.
        const terminal = str(b["program"]) !== undefined && (b["file"] ?? null) === null;
        blocks.push({
          id,
          sessionId,
          sessionName: sessionName ?? sessionId,
          tabId,
          ...(tabName === undefined ? {} : { tabName }),
          ...(title === undefined ? {} : { title }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(cols === undefined ? {} : { cols }),
          live: terminal && b["live"] === true && (b["exited"] ?? null) === null,
          working: working.get(id) === true,
        });
      }
    }
  }
  return { sessions, blocks };
}

export async function layout(exec: Exec): Promise<TernLayout> {
  return parseLayout(await ternCall(exec, ["inspect"]));
}

/** The session a name or id names: an id match first (ids are stable), then the name. */
export const findSession = (l: TernLayout, wanted: string): TernSession | undefined =>
  l.sessions.find((s) => s.id === wanted) ?? l.sessions.find((s) => s.name === wanted);
