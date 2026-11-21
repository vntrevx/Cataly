import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { appendJsonlLine, isSingleLine } from "./fs-utils.js";

export type LessonOutcome = "pending" | "helped" | "no-effect" | "harmful" | "encoded";

export type Lesson = {
  readonly id: string;
  readonly at: string;
  readonly lane: string;
  readonly cwd?: string;
  readonly scope?: "global";
  readonly rule: string;
  readonly evidence: string;
  readonly outcome: LessonOutcome;
};

export type LessonInput = Pick<Lesson, "lane" | "rule" | "evidence"> &
  ({ readonly cwd: string; readonly scope?: undefined } | { readonly scope: "global"; readonly cwd?: undefined });

export type LessonRead = {
  readonly lessons: Lesson[];
  readonly omitted: Lesson[];
  readonly problems: string[];
};

export type LessonJournal = {
  readonly lessons: Lesson[];
  readonly problems: string[];
};

export class LessonError extends Error {}

export const LANE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const REPO_LESSON_CAP = 8;
export const GLOBAL_LESSON_CAP = 12;

export const isLessonOutcome = (value: unknown): value is LessonOutcome =>
  value === "pending" || value === "helped" || value === "no-effect" || value === "harmful" || value === "encoded";

const scopePath = (cwd: string): string => {
  if (!isSingleLine(cwd, 4096)) throw new LessonError("cwd must be a nonempty single-line path");
  const abs = resolve(cwd);
  const canonical = existsSync(abs) ? realpathSync(abs) : abs;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
};

const parseLesson = (value: unknown): Lesson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LessonError("lesson record must be a JSON object");
  }
  const r = value as Record<string, unknown>;
  if (typeof r["id"] !== "string" || !r["id"].trim()) throw new LessonError("missing id");
  if (typeof r["at"] !== "string" || !Number.isFinite(Date.parse(r["at"]))) throw new LessonError("invalid at");
  if (typeof r["lane"] !== "string" || !LANE_KEY_PATTERN.test(r["lane"])) throw new LessonError("invalid lane key");
  if (!isSingleLine(r["rule"], 400)) throw new LessonError("rule must be one line (max 400)");
  if (!isSingleLine(r["evidence"], 2000)) throw new LessonError("evidence must be one line (max 2000)");
  if (!isLessonOutcome(r["outcome"])) throw new LessonError("invalid outcome");
  const isGlobal = r["scope"] === "global";
  if (isGlobal) {
    if ("cwd" in r && r["cwd"] !== undefined) throw new LessonError("global lesson cannot have cwd");
  } else {
    if (typeof r["cwd"] !== "string" || !isAbsolute(r["cwd"]))
      throw new LessonError("repo lesson requires absolute cwd");
  }
  return r as Lesson;
};

export class Lessons {
  readonly path: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "lessons.jsonl");
  }

  read(cwd?: string): LessonJournal {
    if (!existsSync(this.path)) return { lessons: [], problems: [] };
    const latest = new Map<string, Lesson>();
    const problems: string[] = [];
    for (const [index, line] of readFileSync(this.path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const lesson = parseLesson(JSON.parse(line));
        latest.set(lesson.id, lesson);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof LessonError)) throw error;
        problems.push(`${this.path}:${index + 1}: ${error.message}`);
      }
    }
    const target = cwd === undefined ? undefined : scopePath(cwd);
    const lessons = [...latest.values()]
      .filter((lesson) => {
        if (target === undefined) return true;
        if (lesson.scope === "global") return true;
        if (!lesson.cwd) return false;
        const normalized = process.platform === "win32" ? lesson.cwd.toLowerCase() : lesson.cwd;
        return normalized === target;
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { lessons, problems };
  }

  add(input: LessonInput, now = Date.now()): Lesson {
    if (!LANE_KEY_PATTERN.test(input.lane)) {
      throw new LessonError(`invalid lane key: ${input.lane}`);
    }
    const where =
      input.scope === "global"
        ? { scope: "global" as const }
        : { cwd: existsSync(resolve(input.cwd)) ? realpathSync(resolve(input.cwd)) : resolve(input.cwd) };
    const lesson = parseLesson({
      id: randomUUID(),
      at: new Date(now).toISOString(),
      lane: input.lane,
      rule: input.rule.trim(),
      evidence: input.evidence.trim(),
      outcome: "pending",
      ...where,
    });
    appendJsonlLine(this.path, lesson);
    return lesson;
  }

  mark(id: string, outcome: LessonOutcome): Lesson {
    if (!isLessonOutcome(outcome)) throw new LessonError(`invalid outcome: ${String(outcome)}`);
    const previous = this.read().lessons.find((l) => l.id === id);
    if (!previous) throw new LessonError(`lesson not found: ${id}`);
    const updated: Lesson = { ...previous, outcome };
    appendJsonlLine(this.path, updated);
    return updated;
  }

  forRepo(cwd: string): LessonRead {
    const { lessons, problems } = this.read(cwd);
    const active = lessons.filter((l) => l.outcome === "pending" || l.outcome === "helped");
    const globalAll = active.filter((l) => l.scope === "global");
    const repoAll = active.filter((l) => l.scope !== "global");
    const global = globalAll.slice(0, GLOBAL_LESSON_CAP);
    const repo = repoAll.slice(0, REPO_LESSON_CAP);
    return {
      lessons: [...global, ...repo],
      omitted: [...globalAll.slice(GLOBAL_LESSON_CAP), ...repoAll.slice(REPO_LESSON_CAP)],
      problems,
    };
  }
}

export function renderLessons(lessons: readonly Lesson[]): string {
  const global = lessons.filter((l) => l.scope === "global");
  const repo = lessons.filter((l) => l.scope !== "global");
  const blocks: string[] = [];
  if (global.length > 0) {
    blocks.push(
      `## Lessons for every lane\n${global.map((l) => `- [${l.outcome}; ${l.lane}] ${l.rule}`).join("\n")}\n`,
    );
  }
  if (repo.length > 0) {
    blocks.push(`## Lessons for this repo\n${repo.map((l) => `- [${l.outcome}; ${l.lane}] ${l.rule}`).join("\n")}\n`);
  }
  return blocks.join("\n");
}
