import type { Clock } from "../run.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  /** Explicit read-only RPCs may use POST; unknown operations remain mutations. */
  readonly readOnly?: boolean;
  /** Safe operation label, never a credential-bearing URL. */
  readonly operation?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
  readonly redirect?: "error" | "follow" | "manual";
  readonly signal?: AbortSignal;
};
export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    ...(req.headers === undefined ? {} : { headers: req.headers }),
    ...(req.body === undefined ? {} : { body: req.body }),
    ...(req.redirect === undefined ? {} : { redirect: req.redirect }),
    ...(req.signal === undefined ? {} : { signal: req.signal }),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly outcome: "rejected" | "uncertain" | "confirmed" = "rejected",
    readonly receipt?: { readonly channel: string; readonly messageId: string },
  ) {
    super(message);
  }
}

export class DeliveryUncertainError extends MessengerError {
  /** Unverified ID from a fully read 2xx body, never a confirmed receipt. */
  declare readonly candidateReceipt?: { readonly id: string };

  constructor(operation: string, status = 0, candidateReceipt?: { readonly id: string }) {
    super(
      `${operation}: delivery uncertain${status ? ` (HTTP ${status})` : ""}; the request may have succeeded; do not resend. Inspect the original remote target and reconcile its IDs before retrying.`,
      status,
      "DELIVERY_UNCERTAIN",
      "uncertain",
    );
    if (candidateReceipt !== undefined) this.candidateReceipt = candidateReceipt;
  }
}

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$("))
    throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return text;
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

export const withBackoff = async (
  http: Http,
  clock: Clock,
  req: HttpRequest,
  policy: RetryPolicy = DEFAULT_RETRY,
  retryAfterFromBody?: (body: string) => number | undefined,
): Promise<HttpResponse> => {
  const mutation = req.method !== "GET" && req.readOnly !== true;
  const operation = req.operation ?? `messenger ${req.method}`;
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    req.signal?.throwIfAborted();
    try {
      last = await http(req);
    } catch (error) {
      if (mutation) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        const safeCode =
          typeof code === "string" &&
          ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
            ? ` (${code})`
            : "";
        throw new DeliveryUncertainError(`${operation}${safeCode}`);
      }
      throw error;
    }
    if (
      mutation &&
      (last.status === 408 || last.status >= 500 || (last.status >= 200 && last.status < 400 && req.signal?.aborted))
    ) {
      let candidateReceipt: { readonly id: string } | undefined;
      if (last.status >= 200 && last.status < 300) {
        try {
          const body = JSON.parse(last.body) as { readonly id?: unknown } | null;
          if (typeof body?.id === "string" && body.id.length > 0) candidateReceipt = { id: body.id };
        } catch {
          // A non-JSON body cannot supply an ID candidate.
        }
      }
      throw new DeliveryUncertainError(operation, last.status, candidateReceipt);
    }
    req.signal?.throwIfAborted();
    // Platform 429 responses reject the request; 5xx on reads can be retried safely.
    if (last.status !== 429 && last.status < 500) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = [header, fromBody].find(
      (seconds) => seconds !== undefined && Number.isFinite(seconds) && seconds > 0,
    );
    const waitMs = waitS !== undefined ? waitS * 1000 : Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    if (attempt < policy.attempts - 1) {
      const ms = last.status === 429 ? waitMs : Math.min(policy.maxMs, waitMs);
      if (!req.signal) await clock.sleep(ms);
      else {
        const signal = req.signal;
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          await promise;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      }
    }
  }
  return last as HttpResponse;
};
