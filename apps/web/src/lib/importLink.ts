import { deflateSync, Inflate } from "fflate";

/**
 * Links that open a model as a new design.
 *
 * Everything lives in the fragment, which the browser never sends to a server:
 *
 * - `#name=Bracket&import=stl:<base64url>` carries a binary or ASCII STL,
 *   compressed with raw DEFLATE.
 * - `#import=https://example.com/part.stl` names a file the browser fetches;
 *   the host has to allow it (CORS).
 *
 * `import` is always the last parameter: everything after `import=` is its
 * value, so a fetched address may keep its own `?a=1&b=2` unencoded.
 */

export type ImportLink =
  | { kind: "stl"; name: string; bytes: Uint8Array }
  | { kind: "url"; name: string; url: string };

export type ImportLinkErrorCode = "damaged" | "tooLarge" | "unsupported" | "fetchFailed";

export class ImportLinkError extends Error {
  constructor(readonly code: ImportLinkErrorCode, message: string = code) {
    super(message);
    this.name = "ImportLinkError";
  }
}

/** Longest link "Copy link" hands out. Chrome takes about 2 MB; other browsers and apps cut far sooner. */
export const IMPORT_LINK_MAX_LENGTH = 1_000_000;
/** Most an embedded STL may inflate to: about 1.3 million triangles. A small link cannot become a huge one. */
export const IMPORT_LINK_MAX_STL_BYTES = 64 * 1024 * 1024;
/** Most a fetched file may weigh. */
export const IMPORT_LINK_MAX_FETCH_BYTES = 128 * 1024 * 1024;

const IMPORT_KEY = "import=";
const STL_PREFIX = "stl:";
const NAME_MAX_LENGTH = 80;
const FETCHABLE_EXTENSIONS = new Set(["stl", "obj", "3mf", "step", "stp", "svg"]);
// A design file or a backup from a link could replace what is in this browser; models only.
const REFUSED_EXTENSIONS = new Set(["lyl", "skf", "zip"]);

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ImportLinkError("damaged");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  } catch {
    throw new ImportLinkError("damaged");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Inflates, but stops as soon as the output passes `limit`. */
function inflateCapped(data: Uint8Array, limit: number) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  const stream = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > limit) throw new ImportLinkError("tooLarge");
    chunks.push(chunk);
    if (final) finished = true;
  });
  try {
    stream.push(data, true);
  } catch (error) {
    if (error instanceof ImportLinkError) throw error;
    throw new ImportLinkError("damaged");
  }
  if (!finished || total === 0) throw new ImportLinkError("damaged");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A design name from a link: no path, no control characters, not endless. */
export function cleanImportLinkName(name: string) {
  return name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX_LENGTH)
    .trim();
}

function decodeComponent(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw new ImportLinkError("damaged");
  }
}

/**
 * Reads `location.hash`. `null` when it holds no import; throws
 * `ImportLinkError` when it holds one that cannot be used.
 */
export function readImportLink(hash: string): ImportLink | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const start = fragment.startsWith(IMPORT_KEY) ? 0 : fragment.indexOf(`&${IMPORT_KEY}`) + 1;
  if (start === 0 && !fragment.startsWith(IMPORT_KEY)) return null; // indexOf gave -1
  const value = fragment.slice(start + IMPORT_KEY.length);
  const params = new URLSearchParams(fragment.slice(0, start));
  const name = cleanImportLinkName(params.get("name") ?? "");

  if (value.startsWith(STL_PREFIX)) {
    const compressed = fromBase64Url(value.slice(STL_PREFIX.length));
    if (!compressed.length) throw new ImportLinkError("damaged");
    return { kind: "stl", name, bytes: inflateCapped(compressed, IMPORT_LINK_MAX_STL_BYTES) };
  }

  const address = /^https?%3A/i.test(value) ? decodeComponent(value) : value;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ImportLinkError("damaged");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ImportLinkError("unsupported");
  return { kind: "url", name, url: url.href };
}

/** A link to `base` that opens `stl` as a new design called `name`. Throws `tooLarge` past `maxLength`. */
export function stlImportLink(base: string, stl: Uint8Array, name: string, maxLength = IMPORT_LINK_MAX_LENGTH) {
  const url = new URL(base);
  url.search = "";
  const cleanName = cleanImportLinkName(name);
  const nameParam = cleanName ? `${new URLSearchParams({ name: cleanName })}&` : "";
  url.hash = `${nameParam}${IMPORT_KEY}${STL_PREFIX}${toBase64Url(deflateSync(stl, { level: 9 }))}`;
  const link = url.href;
  if (link.length > maxLength) throw new ImportLinkError("tooLarge");
  return link;
}

function extensionOf(fileName: string) {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return match ? match[1].toLowerCase() : "";
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileNameFor(name: string, fallbackName: string, extension: string) {
  const base = (name || fallbackName).replace(/\.[a-z0-9]+$/i, (suffix) => (FETCHABLE_EXTENSIONS.has(suffix.slice(1).toLowerCase()) ? "" : suffix));
  return `${base}.${extension}`;
}

/** The embedded STL as a file for the usual import. */
export function importLinkStlFile(link: Extract<ImportLink, { kind: "stl" }>, fallbackName: string) {
  return new File([link.bytes as BlobPart], fileNameFor(link.name, fallbackName, "stl"), { type: "model/stl" });
}

/** The host a fetched link points at, for the notice while it loads. */
export function importLinkHost(link: Extract<ImportLink, { kind: "url" }>) {
  return new URL(link.url).host;
}

/**
 * Fetches a linked file, without cookies or referrer. The format comes from
 * the address, else from the name, else STL is assumed.
 */
export async function fetchImportLinkFile(
  link: Extract<ImportLink, { kind: "url" }>,
  fallbackName: string,
  fetchImpl: typeof fetch = fetch,
) {
  const url = new URL(link.url);
  const pathName = cleanImportLinkName(safeDecode(url.pathname.split("/").pop() ?? ""));
  const candidates = [extensionOf(pathName), extensionOf(link.name)];
  if (candidates.some((candidate) => REFUSED_EXTENSIONS.has(candidate))) throw new ImportLinkError("unsupported");
  // A download address such as /file.php?id=7 says nothing; STL is the likely guess.
  const extension = candidates.find((candidate) => FETCHABLE_EXTENSIONS.has(candidate)) ?? "stl";

  let response: Response;
  try {
    response = await fetchImpl(url.href, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    // A refused CORS request looks just like a network failure from here.
    throw new ImportLinkError("fetchFailed");
  }
  if (!response.ok) throw new ImportLinkError("fetchFailed", `HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > IMPORT_LINK_MAX_FETCH_BYTES) throw new ImportLinkError("tooLarge");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > IMPORT_LINK_MAX_FETCH_BYTES) throw new ImportLinkError("tooLarge");
  if (buffer.byteLength === 0) throw new ImportLinkError("damaged");
  return new File([buffer], fileNameFor(link.name || pathName.replace(/\.[a-z0-9]+$/i, ""), fallbackName, extension));
}
