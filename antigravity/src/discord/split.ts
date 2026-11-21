export const DISCORD_LIMIT = 2000;
const FENCE_RUN = /`{3,}/g;
const LANGUAGE = /^([a-z0-9_+\-.#]{1,32})\r?\n/i;

export function cutAt(text: string, limit: number, breaks: readonly string[]): number {
  const window = text.slice(0, limit);
  let at = limit;
  for (const mark of breaks) {
    const found = window.lastIndexOf(mark);
    if (found >= limit / 2) {
      at = found + mark.length;
      break;
    }
  }
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) at--;
  return at;
}

function openBlock(text: string): { readonly language: string; readonly at: number } | undefined {
  let open: { readonly language: string; readonly at: number } | undefined;
  for (const m of text.matchAll(FENCE_RUN)) {
    if (open !== undefined) open = undefined;
    else open = { language: LANGUAGE.exec(text.slice((m.index ?? 0) + m[0].length))?.[1] ?? "", at: m.index ?? 0 };
  }
  return open;
}

function outsideRun(text: string, at: number): number {
  let moved = at;
  while (moved > 0 && text[moved - 1] === "`" && text[moved] === "`") moved--;
  return moved > 0 ? moved : at;
}

/**
 * Split long messages into <=2000 UTF-16 code unit chunks, closing and reopening code fences cleanly across parts.
 */
export function splitForDiscord(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (reopen.length + rest.length > DISCORD_LIMIT) {
    let budget = DISCORD_LIMIT - reopen.length;
    for (;;) {
      const at = outsideRun(rest, cutAt(rest, budget, ["\n\n", "\n", " "]));
      const part = reopen + rest.slice(0, at);
      const block = openBlock(part);
      const opener = block === undefined ? -1 : part.lastIndexOf("\n", block.at) + 1 - reopen.length;
      if (block && opener > 0 && !/\S/.test(part.slice(block.at).replace(/^`+[^\n]*\n?/, ""))) {
        budget = opener;
        continue;
      }
      const close = block === undefined ? "" : `${part.endsWith("\n") ? "" : "\n"}\`\`\``;
      if (part.length + close.length > DISCORD_LIMIT) {
        budget -= close.length;
        continue;
      }
      parts.push(part + close);
      rest = rest.slice(at);
      reopen = "";
      if (block !== undefined) {
        const closer = /^`{3,}/.exec(rest);
        if (closer) rest = rest.slice(closer[0].length);
        else reopen = `\`\`\`${block.language}\n`;
      }
      break;
    }
  }
  parts.push(reopen + rest);
  const kept = parts.filter((part) => part.trim() !== "");
  return kept.length > 0 ? kept : parts.slice(0, 1);
}
