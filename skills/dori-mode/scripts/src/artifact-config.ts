import { isAbsolute, resolve } from "node:path";

export type ArtifactRoot = { readonly path: string; readonly baseUrl?: string };

/** A publication mapping is explicit; absence never guesses a web server or uploads a file. */
export const parseArtifactRoots = (
  value: unknown,
  expand: (path: string) => string,
  ErrorType: new (message: string) => Error,
): readonly ArtifactRoot[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ErrorType("invalid artifactRoots: expected an array");
  const paths = new Set<string>();
  return value.map((entry: unknown, index) => {
    const invalid = (detail: string): never => {
      throw new ErrorType(`invalid artifactRoots[${index}]: ${detail}`);
    };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid("expected an object");
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== "path" && key !== "baseUrl")) return invalid("unknown field");
    if (typeof row["path"] !== "string" || !row["path"].trim() || /[\p{Cc}\p{Cf}]/u.test(row["path"]))
      return invalid("path must be a nonempty absolute path without control characters");
    const expanded = expand(row["path"]);
    if (!isAbsolute(expanded)) return invalid("path must be absolute (or start with ~/)");
    const path = resolve(expanded);
    if (paths.has(path)) return invalid("duplicate root path");
    paths.add(path);
    if (row["baseUrl"] === undefined) return { path };
    if (typeof row["baseUrl"] !== "string" || /[\p{Cc}\p{Cf}]/u.test(row["baseUrl"]))
      return invalid("baseUrl must be an HTTP(S) URL without control characters");
    let url: URL;
    try {
      url = new URL(row["baseUrl"]);
    } catch {
      return invalid("baseUrl must be an HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes("?") ||
      url.href.includes("#")
    )
      return invalid("baseUrl must use HTTP(S) without credentials, a query or a fragment");
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return { path, baseUrl: url.href };
  });
};
