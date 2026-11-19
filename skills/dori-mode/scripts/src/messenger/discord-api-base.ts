import { MessengerError } from "./http.ts";

/**
 * An environment-supplied REST API prefix may target only loopback HTTP.
 * Credentials and query/fragment components are not usable API prefixes.
 */
export function discordApiBase(value: string | undefined): string {
  const fallback = "https://discord.com/api/v10";
  if (value === undefined || value === "") return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MessengerError("DORI_DISCORD_API_BASE is not a URL", 0);
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.href !== url.origin + url.pathname
  )
    throw new MessengerError(
      "DORI_DISCORD_API_BASE must use a loopback http origin without credentials, query or fragment",
      0,
    );
  return url.href.replace(/\/+$/, "");
}
