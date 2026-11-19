import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sessionFileStart } from "./session-id.ts";
import { createUsageIndex, type Pool } from "./usage-index.ts";
import type { SessionUsage, UsageEntry } from "./usage-session.ts";

type Family = {
  id: string;
  refs: Set<string>;
  inherited: Set<string>;
  copies: Map<string, Set<string>>;
  read: SessionUsage;
  expected: Set<string>;
  receiptsFrom: number;
  scope: Set<Family>;
  owned: boolean;
  isChild: boolean;
  advisor: boolean;
};
const identity = (entry: UsageEntry) => [entry.id, entry.at].join(":");

/** Native tasks share an artifact directory. Fork sources prove inheritance without owning their charges. */
export const readUsageTree = async (
  roots: readonly { file: string; id: string }[],
  from: number,
  until: number,
  cached: Record<string, SessionUsage>,
) => {
  const issues: string[] = [],
    main: UsageEntry[] = [],
    children: UsageEntry[] = [];
  const { files, load, journalFiles, index, latest } = createUsageIndex(cached, issues);
  const families = new Map<string, Family>(),
    aliases = new Map<string, Set<string>>();
  const charges: { family: Family; entry: UsageEntry }[] = [];
  const visiting = new Set<string>(),
    sessionIds = new Set<string>(),
    childIds = new Set<string>();
  const visit = async (
    file: string,
    isChild: boolean,
    id?: string,
    parent?: Family,
    shared?: Pool,
    advisor = false,
    owned = true,
  ): Promise<Family | undefined> => {
    file = resolve(file);
    const existing = families.get(file);
    if (existing) {
      if (visiting.has(file)) issues.push("cyclic session ancestry");
      if (owned) for (const member of existing.scope) member.owned = true;
      return existing;
    }
    let read: SessionUsage;
    try {
      read = await load(file);
    } catch {
      issues.push("session file unreadable");
      return;
    }
    const receiptedSeance = read.seance && parent?.expected.has(basename(file, ".jsonl"));
    if (
      parent &&
      !advisor &&
      !read.continuation &&
      !receiptedSeance &&
      (!read.parent || !parent.refs.has(read.parent))
    ) {
      issues.push("child session relationship unverified");
      return;
    }
    if (id && read.id !== id) {
      issues.push("session identity does not match its file");
      return;
    }
    issues.push(...read.errors);
    if (read.continuation && read.parent !== read.continuation) issues.push("continuation parent identity mismatch");
    const refs = aliases.get(read.id) ?? new Set<string>();
    refs.add(read.id);
    refs.add(file);
    aliases.set(read.id, refs);
    // Rotation mints a header after its triggering entry; ordinary forks begin at their new header.
    const lower = read.continuation ? from : Math.max(from, read.startedAt);
    const family: Family = {
      id: read.id,
      refs,
      inherited: new Set(parent?.inherited),
      copies: new Map(parent?.copies),
      read,
      expected: new Set(),
      receiptsFrom: read.seance ? read.startedAt : -Infinity,
      scope: new Set(),
      owned,
      isChild,
      advisor,
    };
    family.scope.add(family);
    families.set(file, family);
    visiting.add(file);
    const origin = read.continuation ?? (!isChild && !read.seance ? read.parent : null);
    if (origin) {
      const matches: string[] = [];
      const candidates = !isAbsolute(origin) && shared ? (shared.byId.get(origin) ?? []) : journalFiles(dirname(file));
      for (const candidate of candidates) {
        const candidateId = sessionFileStart(basename(candidate))?.id;
        if (isAbsolute(origin) ? candidate !== origin : candidateId && candidateId !== origin) continue;
        try {
          if (candidate === origin || (await load(candidate)).id === origin) matches.push(candidate);
        } catch {
          issues.push("session ancestry candidate unreadable");
        }
      }
      if (matches.length === 1 && matches[0] !== file) {
        const prior = await visit(
          matches[0]!,
          isChild,
          read.continuation ?? undefined,
          parent,
          shared,
          advisor,
          owned && !!read.continuation,
        );
        if (prior) {
          family.receiptsFrom = read.continuation
            ? prior.receiptsFrom
            : Math.max(family.receiptsFrom, prior.receiptsFrom);
          for (const ref of prior.refs) family.refs.add(ref);
          for (const entry of prior.inherited) family.inherited.add(entry);
          for (const [id, entries] of prior.copies)
            family.copies.set(id, new Set([...(family.copies.get(id) ?? []), ...entries]));
          if (read.continuation) {
            family.id = prior.id;
            for (const member of prior.scope) family.scope.add(member);
          } else {
            for (const member of prior.scope)
              family.copies.set(
                member.read.id,
                new Set([...(family.copies.get(member.read.id) ?? []), ...member.read.entries.map(identity)]),
              );
          }
        }
      } else issues.push("session ancestry unavailable or cyclic");
    }
    // Receipt times do not bound child activity. Only seance's inherited context is not an owned spawn.
    const tasks = read.tasks.filter((task) => task.at >= family.receiptsFrom);
    family.expected = new Set(tasks.flatMap((task) => task.children?.map((child) => child.id) ?? []));
    // Exclude inherited identities rather than a continuation header's time.
    const inherited = new Set(family.inherited);
    for (const entry of read.entries) {
      const key = identity(entry);
      family.inherited.add(key);
      if (entry.at < lower || entry.at >= until || inherited.has(key) || family.copies.get(read.id)?.has(key)) continue;
      charges.push({ family, entry });
    }
    const own = await index(join(dirname(file), basename(file, ".jsonl")));
    const direct = new Map<string, Pool>();
    for (const pool of shared ? [shared, own] : [own]) {
      for (const ref of family.refs) for (const child of pool.byParent.get(ref) ?? []) direct.set(child, pool);
      // Native seance headers point at their historical source, not the launching parent.
      // Only this parent's exact task receipt can establish ownership of such a child.
      for (const child of pool.paths)
        if (family.expected.has(basename(child, ".jsonl")) && files[child]?.seance) direct.set(child, pool);
    }
    const childNames = new Set([...direct.keys()].map((path) => basename(path, ".jsonl")));
    for (const task of tasks) {
      if (task.children === null)
        issues.push(
          childNames.size
            ? "task child identities unavailable"
            : "task result exists without inspectable child sessions",
        );
      else if (task.children.some((child) => !child.zero && !childNames.has(child.id)))
        issues.push("expected child session unavailable");
    }
    for (const [child, pool] of direct) {
      const head = await latest(child, pool);
      const member = head ? await visit(head, true, undefined, family, pool, false, owned) : undefined;
      if (member) for (const descendant of member.scope) family.scope.add(descendant);
    }
    for (const file of own.advisors) {
      const head = await latest(file, own);
      const member = head ? await visit(head, isChild, undefined, family, own, true, owned) : undefined;
      if (member) for (const descendant of member.scope) family.scope.add(descendant);
    }
    if (own.paths.some((path) => !families.has(path))) issues.push("child session relationship unverified");
    visiting.delete(file);
    return family;
  };
  for (const root of roots) await visit(root.file, false, root.id);
  const calls = new Map<string, UsageEntry>();
  for (const { family, entry } of charges) {
    if (!family.owned) continue;
    const id = [family.read.id, entry.id].join(":"),
      previous = calls.get(id);
    if (previous) {
      if (previous.at !== entry.at || previous.tokens !== entry.tokens || previous.costUsd !== entry.costUsd)
        issues.push("conflicting copied usage record");
      continue;
    }
    const call = { ...entry, id };
    calls.set(id, call);
    (family.isChild ? children : main).push(call);
  }
  for (const family of families.values()) {
    if (!family.owned) continue;
    sessionIds.add(family.read.id);
    if (family.isChild && !family.advisor) childIds.add(family.id);
  }
  return { files, issues, main, children, childSessions: childIds.size, sessionIds };
};
