import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFile, withFileLock } from "./fs-utils.js";
import { validateLaneKey } from "./lanes.js";
import { defaultRunner, doneSyntaxErrors, type Runner } from "./signals.js";

export type BacklogStatus = "open" | "running" | "done" | "dropped";

export type BacklogItem = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly done: string;
  readonly priority: number;
  readonly status: BacklogStatus;
  readonly decision?: string;
  readonly source?: string;
  readonly issueRef?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AddBacklogInput = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly done: string;
  readonly brief: string;
  readonly priority?: number;
  readonly decision?: string;
  readonly source?: string;
  readonly issueRef?: string;
};

export class BacklogError extends Error {}

export class Backlog {
  readonly dir: string;

  constructor(readonly stateDir: string) {
    this.dir = join(stateDir, "backlog");
  }

  metaPath(id: string): string {
    validateLaneKey(id);
    return join(this.dir, `${id}.json`);
  }

  briefPath(id: string): string {
    validateLaneKey(id);
    return join(this.dir, `${id}.md`);
  }

  get(id: string): { item: BacklogItem; brief: string } | null {
    const path = this.metaPath(id);
    if (!existsSync(path)) return null;
    const item = JSON.parse(readFileSync(path, "utf8")) as BacklogItem;
    const bPath = this.briefPath(id);
    const brief = existsSync(bPath) ? readFileSync(bPath, "utf8") : "";
    return { item, brief };
  }

  list(status?: BacklogStatus): BacklogItem[] {
    if (!existsSync(this.dir)) return [];
    const items: BacklogItem[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const item = JSON.parse(readFileSync(join(this.dir, entry.name), "utf8")) as BacklogItem;
        if (!status || item.status === status) items.push(item);
      } catch {
        // skip corrupted file
      }
    }
    return items.sort(
      (a, b) =>
        a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  add(input: AddBacklogInput, now = Date.now()): BacklogItem {
    validateLaneKey(input.id);
    const errs = doneSyntaxErrors(input.done);
    if (errs.length > 0) throw new BacklogError(`invalid Done = line: ${errs.join("; ")}`);
    const priority = input.priority ?? 5;
    if (!Number.isInteger(priority) || priority < 1 || priority > 9) {
      throw new BacklogError("priority must be 1..9");
    }
    const meta = this.metaPath(input.id);
    return withFileLock(`${meta}.lock`, () => {
      if (existsSync(meta)) throw new BacklogError(`backlog item "${input.id}" already exists`);
      mkdirSync(this.dir, { recursive: true });
      const at = new Date(now).toISOString();
      const item: BacklogItem = {
        id: input.id,
        title: input.title.trim(),
        cwd: resolve(input.cwd),
        done: input.done.replace(/^Done\s*=\s*/i, "").trim(),
        priority,
        status: "open",
        ...(input.decision?.trim() ? { decision: input.decision.trim() } : {}),
        ...(input.source?.trim() ? { source: input.source.trim() } : {}),
        ...(input.issueRef?.trim() ? { issueRef: input.issueRef.trim() } : {}),
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
      atomicWriteFile(this.briefPath(input.id), `${input.brief.trim()}\n`);
      atomicWriteFile(meta, `${JSON.stringify(item, null, 2)}\n`);
      return item;
    });
  }

  decide(id: string, answer: string, now = Date.now()): BacklogItem {
    const trimmed = answer.trim();
    if (!trimmed) throw new BacklogError("decision answer must not be empty");
    const meta = this.metaPath(id);
    return withFileLock(`${meta}.lock`, () => {
      const existing = this.get(id);
      if (!existing) throw new BacklogError(`backlog item not found: ${id}`);
      const nextBrief = `${existing.brief.trimEnd()}\n\n## Owner Decision (${new Date(now).toISOString()})\n${
        existing.item.decision ? `Q: ${existing.item.decision}\n` : ""
      }A: ${trimmed}\n`;
      atomicWriteFile(this.briefPath(id), nextBrief);
      const { decision: _removed, ...rest } = existing.item;
      const updated: BacklogItem = {
        ...rest,
        updatedAt: new Date(now).toISOString(),
      };
      atomicWriteFile(meta, `${JSON.stringify(updated, null, 2)}\n`);
      return updated;
    });
  }

  setStatus(id: string, status: BacklogStatus, now = Date.now()): BacklogItem {
    const meta = this.metaPath(id);
    return withFileLock(`${meta}.lock`, () => {
      const existing = this.get(id);
      if (!existing) throw new BacklogError(`backlog item not found: ${id}`);
      const updated: BacklogItem = {
        ...existing.item,
        status,
        attempts: status === "running" ? existing.item.attempts + 1 : existing.item.attempts,
        updatedAt: new Date(now).toISOString(),
      };
      atomicWriteFile(meta, `${JSON.stringify(updated, null, 2)}\n`);
      return updated;
    });
  }

  drop(id: string, now = Date.now()): BacklogItem {
    return this.setStatus(id, "dropped", now);
  }

  nextEligible(limit = 3): BacklogItem[] {
    return this.list("open")
      .filter((item) => !item.decision)
      .slice(0, limit);
  }

  async importGithubIssues(
    repo: string,
    label: string,
    cwd: string,
    priority = 5,
    runner: Runner = defaultRunner,
    now = Date.now(),
  ): Promise<{ imported: BacklogItem[]; skipped: string[] }> {
    const res = await runner([
      "gh",
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      label,
      "--state",
      "open",
      "--json",
      "number,title,body,url",
      "--limit",
      "30",
    ]);
    if (res.code !== 0) {
      throw new BacklogError(`gh issue list failed: ${res.err || res.out}`);
    }
    const issues = JSON.parse(res.out) as { number: number; title: string; body?: string; url: string }[];
    const imported: BacklogItem[] = [];
    const skipped: string[] = [];
    const repoSlug = repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 32);

    for (const issue of issues) {
      const id = `${repoSlug}-issue-${issue.number}`.slice(0, 64);
      if (this.get(id)) {
        skipped.push(id);
        continue;
      }
      const item = this.add(
        {
          id,
          title: `#${issue.number}: ${issue.title}`,
          cwd,
          done: `closed ${repo}#${issue.number}`,
          brief: [`GitHub Issue: ${issue.url}`, "", issue.body?.trim() || "(no issue body)"].join("\n"),
          priority,
          source: `github:${repo}#${issue.number}`,
          issueRef: `${repo}#${issue.number}`,
        },
        now,
      );
      imported.push(item);
    }
    return { imported, skipped };
  }
}
