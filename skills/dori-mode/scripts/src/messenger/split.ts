/**
 * Where to cut `text` (longer than `limit`) so the first part fits: just after the last of the first `breaks` found in
 * the back half of the window, tried in order, else at `limit`. A cut never separates a UTF-16 surrogate pair.
 */
export const cutAt = (text: string, limit: number, breaks: readonly string[]): number => {
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
};

/** Discord's message content limit; counting UTF-16 code units never undercounts its characters. */
export const DISCORD_LIMIT = 2000;
/** A code block marker as Discord's renderer reads it: any run of three or more backticks, wherever it sits. */
const FENCE_RUN = /`{3,}/g;
/** The language an opening marker names: letters and the like up to the end of its line. */
const LANGUAGE = /^([a-z0-9_+\-.#]{1,32})\r?\n/i;

/**
 * Discord pairs block markers in order, so a block opens at every odd marker and closes at the next one, mid-line and
 * on one line (```js f()```) included. Returns the language of the block still open at the end of `text`, or
 * undefined when every block is closed.
 */
const openBlock = (text: string): { readonly language: string; readonly at: number } | undefined => {
  let open: { readonly language: string; readonly at: number } | undefined;
  for (const m of text.matchAll(FENCE_RUN)) {
    if (open !== undefined) open = undefined;
    else open = { language: LANGUAGE.exec(text.slice(m.index + m[0].length))?.[1] ?? "", at: m.index };
  }
  return open;
};

/** Moves a cut that falls inside a run of backticks to the run's start, so neither part loses a marker. */
const outsideRun = (text: string, at: number): number => {
  let moved = at;
  while (moved > 0 && text[moved - 1] === "`" && text[moved] === "`") moved--;
  return moved > 0 ? moved : at;
};

/**
 * Break text into Discord messages of at most 2000 UTF-16 code units, preferring a blank line, then a newline, then a
 * space in the back half of each window. A code block cut across parts is closed at the end of one part and reopened
 * with its language at the start of the next, so each part renders on its own; when the cut falls just before the
 * block's own closing marker, that marker ends the part instead. Parts that would hold only whitespace are dropped
 * (Discord refuses empty messages); otherwise the text is unchanged.
 */
export const splitForDiscord = (text: string): string[] => {
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (reopen.length + rest.length > DISCORD_LIMIT) {
    let budget = DISCORD_LIMIT - reopen.length;
    for (;;) {
      const at = outsideRun(rest, cutAt(rest, budget, ["\n\n", "\n", " "]));
      const part = reopen + rest.slice(0, at);
      const block = openBlock(part);
      // A block opened by this part's text with nothing after its marker line moves whole to the next part.
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
        // The block's own closing marker right after the cut is the one just added: drop it rather than reopen.
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
};

/** Telegram's one-message bound, counted as the Bot API counts it: characters after entities parsing. */
export const TELEGRAM_LIMIT = 4096;

/** A tag, opening or closing, including an attribute value that holds a `>`. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
/** The named references Telegram accepts, besides the numeric ones. */
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"' };
const ENTITY = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot));/g;
const TAG_NAME = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
/** Elements with no closing tag, which never stay open across a cut. */
const VOID = new Set(["br", "hr", "img"]);

/** What one entity reference stands for, or the source when it is not one Telegram would accept. */
const entityText = (
  source: string,
  dec: string | undefined,
  hex: string | undefined,
  name: string | undefined,
): string => {
  if (name !== undefined) return NAMED[name] ?? source;
  const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : source;
};

/**
 * The characters Telegram counts against its bound for `html`: markup costs nothing, and a reference costs the one
 * character it stands for. UTF-16 code units, as the Bot API counts them.
 */
export const visibleLength = (html: string): number =>
  html.replace(TAG, "").replace(ENTITY, (m, dec?: string, hex?: string, name?: string) => entityText(m, dec, hex, name))
    .length;

/**
 * Where the body may end so that its parsed text holds at most `limit` characters: as far as the text allows, at a
 * blank line, then a newline, then a space in the back half, never inside a tag, an entity reference or a surrogate
 * pair. Markup is not counted, so the tags a cut adds cost nothing.
 */
const htmlCut = (html: string, limit: number): number => {
  let visible = 0;
  let fallback = 0;
  let space = -1;
  let line = -1;
  let blank = -1;
  for (let at = 0; at < html.length; ) {
    const ch = html[at] ?? "";
    let step = 1;
    let cost = 1;
    if (ch === "<") {
      const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/.exec(html.slice(at));
      if (tag) {
        step = tag[0].length;
        cost = 0;
      }
    } else if (ch === "&") {
      const ref = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot));/.exec(html.slice(at));
      if (ref) {
        step = ref[0].length;
        cost = entityText(ref[0], ref[1], ref[2], ref[3]).length;
      }
    } else {
      const code = html.charCodeAt(at);
      if (code >= 0xd800 && code <= 0xdbff && at + 1 < html.length) {
        const next = html.charCodeAt(at + 1);
        if (next >= 0xdc00 && next <= 0xdfff) step = 2;
      }
    }
    if (visible + cost > limit) break;
    visible += cost;
    at += step;
    fallback = at;
    if (visible >= limit / 2) {
      const last = html.slice(Math.max(0, at - step), at);
      if (last === "\n" && html[at - 2] === "\n") blank = at;
      else if (last === "\n") line = at;
      else if (last === " ") space = at;
    }
  }
  return blank >= 0 ? blank : line >= 0 ? line : space >= 0 ? space : fallback;
};

/** The tags still open at `at`, outermost first, each as the source that reopens it. */
const openTagsAt = (html: string, at: number): string[] => {
  const stack: string[] = [];
  for (const m of html.slice(0, at).matchAll(TAG)) {
    const [source = "", closing = "", name = ""] = m;
    if (closing === "") {
      if (!/\/>$/.test(source) && !VOID.has(name.toLowerCase())) stack.push(source);
      continue;
    }
    const open = stack.map((tag) => TAG_NAME.exec(tag)?.[1]?.toLowerCase());
    const found = open.lastIndexOf(name.toLowerCase());
    if (found >= 0) stack.length = found;
  }
  return stack;
};

/**
 * Break HTML into bodies Telegram accepts, each holding at most `limit` characters after entities parsing. Every tag
 * still open at a cut is closed at the end of one body and reopened at the start of the next, so each body is valid
 * markup on its own rather than a fragment Telegram rejects.
 */
export const splitForTelegramHtml = (text: string, limit = TELEGRAM_LIMIT): string[] => {
  if (visibleLength(text) <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  let reopen = "";
  while (visibleLength(reopen + rest) > limit) {
    const cut = Math.max(1, htmlCut(rest, limit));
    const stack = openTagsAt(reopen + rest, reopen.length + cut);
    const close = stack
      .slice()
      .reverse()
      .map((tag) => `</${TAG_NAME.exec(tag)?.[1]?.toLowerCase()}>`)
      .join("");
    parts.push(reopen + rest.slice(0, cut) + close);
    rest = rest.slice(cut);
    reopen = stack.join("");
  }
  parts.push(reopen + rest);
  return parts;
};
