import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  openDiscordAskMailbox,
  readPrivateAskFile,
} from "../skills/dori-mode/scripts/src/messenger/discord-ask-mailbox.ts";
import { isDiscordSnowflake } from "../skills/dori-mode/scripts/src/messenger/discord-inbound-state.ts";
import { Discord } from "../skills/dori-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "../skills/dori-mode/scripts/src/messenger/http.ts";
import { type AskData, parseAskAnswer, projectAskForm } from "./discord-ask-form.ts";

export type DiscordAskRoute = {
  channel: string;
  owner: string;
  receiverStateDir: string;
} & ({ tokenFile: string; tokenFileFormat: "raw" | "dotenv" } | { token: string });
type DialogOptions = { signal?: AbortSignal };
type NativeFormResult = { data: AskData; timedOut?: boolean; notes?: unknown[] };
type FormDialog = (html: string, options?: DialogOptions) => Promise<NativeFormResult | undefined>;
type AskUI = { formDialog?: FormDialog; notify(message: string, type?: "warning"): void };
type PendingAsk = { html: string; route: DiscordAskRoute; stillConnected?: () => Promise<boolean> };

type ObjectMap = Record<string, unknown>;
const record = (value: unknown): value is ObjectMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function routeFor(stateDir: string, session: string): DiscordAskRoute | false | undefined {
  const raw = readPrivateAskFile(join(stateDir, "discord-ask.json"), 64 * 1_024);
  if (raw === undefined) return undefined;
  const config: unknown = JSON.parse(raw);
  if (!record(config) || !record(config["sessions"])) throw new Error("Invalid Discord ASK configuration");
  const entry = Object.hasOwn(config["sessions"], session) ? config["sessions"][session] : undefined;
  if (entry === undefined) return undefined;
  if (entry === false) return false;
  if (!record(entry)) throw new Error("Invalid Discord ASK route");
  const { channel, owner, tokenFile, tokenFileFormat = "raw", receiverStateDir = stateDir } = entry;
  if (
    !isDiscordSnowflake(channel) ||
    !isDiscordSnowflake(owner) ||
    typeof tokenFile !== "string" ||
    !isAbsolute(tokenFile) ||
    (tokenFileFormat !== "raw" && tokenFileFormat !== "dotenv") ||
    typeof receiverStateDir !== "string" ||
    !isAbsolute(receiverStateDir)
  )
    throw new Error("Invalid Discord ASK route");
  return { channel, owner, tokenFile, tokenFileFormat, receiverStateDir };
}

const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);

async function askOnDiscord(
  html: string,
  { route, stillConnected }: PendingAsk,
  signal: AbortSignal,
  warn: (message: string) => void,
) {
  const form = await projectAskForm(html);
  if (!form) {
    warn("This ASK form needs the local OMP dialog; nothing was posted to Discord.");
    return;
  }
  let token: string | undefined;
  if ("token" in route) {
    token = route.token;
  } else {
    const contents = readPrivateAskFile(route.tokenFile, 16_384);
    token =
      route.tokenFileFormat === "dotenv"
        ? /^(?:export[ \t]+)?DORI_DISCORD_TOKEN=(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+))[ \t]*\r?$/m
            .exec(contents ?? "")
            ?.slice(1)
            .find(Boolean)
        : contents?.trim();
    if (!token || !/^[\w.-]+$/.test(token)) throw new Error("Invalid Discord ASK bot token file");
  }
  signal.throwIfAborted();
  const discord = new Discord(fetchHttp, { now: Date.now, sleep: Bun.sleep }, token);
  const path = `/channels/${route.channel}/messages`;
  const mentions = { parse: [], replied_user: false };
  const post = async (content: string, reference?: string) =>
    discord.call<{ id: string }>(
      "POST",
      path,
      {
        content,
        allowed_mentions: mentions,
        nonce: randomUUID().replaceAll("-", "").slice(0, 24),
        enforce_nonce: true,
        ...(reference ? { message_reference: { message_id: reference, fail_if_not_exists: true } } : {}),
      },
      requestSignal(signal),
    );
  // Discord can show a newly created message before the POST has returned its ID.
  // Publish only the shell until replies to its exact message ID have an owner.
  if (stillConnected && !(await stillConnected())) return;
  const question = await post("Preparing a Cataly ASK. Wait for the question before replying.");
  if (!isDiscordSnowflake(question?.id)) throw new Error("Discord did not confirm the ASK message ID");
  const mailbox = openDiscordAskMailbox(route.receiverStateDir, route.channel, question.id, route.owner);
  const seen = new Set<string>();
  try {
    if (stillConnected && !(await stillConnected())) {
      warn("The Discord ASK connection changed; answer in the local dialog.");
      return;
    }
    await discord.call(
      "PATCH",
      `${path}/${question.id}`,
      {
        content: `**Cataly ASK**\n${form.summary}\n\nReply to this message with the answer.`,
        allowed_mentions: mentions,
      },
      requestSignal(signal),
    );
    while (!signal.aborted) {
      for (const reply of mailbox.replies(seen)) {
        signal.throwIfAborted();
        seen.add(reply.id);
        const answer = parseAskAnswer(form, reply.text);
        if ("data" in answer) return answer;
        try {
          await post(
            `ASK answer not accepted: ${answer.error}\nReply to the original ASK message to try again.`,
            reply.id,
          );
        } catch {
          if (!signal.aborted) warn("Discord did not confirm the ASK correction message.");
        }
      }
      await Bun.sleep(250);
    }
  } finally {
    mailbox.close();
  }
}

/** Arms only the exact native ASK forms, never an approval or another dialog. */
export class DiscordAsk {
  #armed?: { wrap: FormDialog; requests: Map<string, PendingAsk>; restore(): void };
  #signal = new AbortController();

  clear(): void {
    this.#armed?.restore();
    this.#armed = undefined;
    this.#signal.abort();
    this.#signal = new AbortController();
  }

  finish(event: unknown): void {
    if (!record(event) || event["toolName"] !== "ask" || typeof event["toolCallId"] !== "string") return;
    const armed = this.#armed;
    armed?.requests.delete(event["toolCallId"]);
    if (armed?.requests.size === 0) armed.restore();
  }

  async arm(
    event: unknown,
    ui: AskUI,
    stateDir: string,
    session: string,
    automatic?: () => Promise<DiscordAskRoute | undefined>,
  ): Promise<void> {
    if (!record(event) || event["toolName"] !== "ask" || typeof event["toolCallId"] !== "string") return;
    const args = event["input"];
    if (!record(args) || typeof args["html"] !== "string") return;
    const requestHtml = args["html"];
    const warn = (message: string) => ui.notify(message, "warning");
    const lifecycle = this.#signal.signal;
    let route: DiscordAskRoute | false | undefined;
    let stillConnected: PendingAsk["stillConnected"];
    try {
      route = routeFor(stateDir, session);
      if (route === undefined && automatic) {
        const chosen = await automatic();
        route = chosen;
        if (chosen && "token" in chosen)
          stillConnected = async () => {
            if (lifecycle.aborted || routeFor(stateDir, session) !== undefined) return false;
            const current = await automatic();
            return (
              !!current &&
              "token" in current &&
              current.token === chosen.token &&
              current.owner === chosen.owner &&
              current.channel === chosen.channel &&
              current.receiverStateDir === chosen.receiverStateDir
            );
          };
      }
    } catch {
      warn("Discord ASK configuration is unreadable; the local dialog is unchanged.");
      return;
    }
    if (!route || lifecycle.aborted) return;
    // Both native tool and extension runners use the descriptors of the same underlying OMP UI object.
    const descriptor = Object.getOwnPropertyDescriptor(ui, "formDialog");
    if (!descriptor?.configurable || typeof descriptor.value !== "function") {
      warn("This OMP UI does not expose the ASK form bridge; the local dialog is unchanged.");
      return;
    }
    const pending = { html: requestHtml, route, stillConnected };
    if (this.#armed && descriptor.value === this.#armed.wrap) {
      this.#armed.requests.set(event["toolCallId"], pending);
      return;
    }
    this.#armed?.restore();
    const requests = new Map([[event["toolCallId"], pending]]);
    const original: FormDialog = descriptor.value;
    const restore = () => {
      if (Object.getOwnPropertyDescriptor(ui, "formDialog")?.value === wrap)
        Object.defineProperty(ui, "formDialog", descriptor);
      if (this.#armed?.wrap === wrap) this.#armed = undefined;
    };
    const wrap: FormDialog = async (html, options) => {
      if (lifecycle.aborted) return original.call(ui, html, options);
      const next = Array.from(requests).find(([, request]) => request.html === html);
      if (!next) return original.call(ui, html, options);
      const [id, selected] = next;
      requests.delete(id);
      if (requests.size === 0) restore();
      const finished = new AbortController();
      const signals = [finished.signal, lifecycle, ...(options?.signal ? [options.signal] : [])];
      const signal = AbortSignal.any(signals);
      const native = Promise.resolve().then(() => original.call(ui, html, { ...options, signal }));
      const remote = askOnDiscord(html, selected, signal, warn).catch(() => {
        if (!signal.aborted) warn("Discord ASK could not be completed; the local dialog is still available.");
        return undefined;
      });
      try {
        return await Promise.race([native, remote.then((answer) => answer ?? native)]);
      } finally {
        finished.abort();
      }
    };
    Object.defineProperty(ui, "formDialog", { ...descriptor, value: wrap });
    this.#armed = { wrap, requests, restore };
  }
}
