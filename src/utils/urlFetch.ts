import type { Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import dns from "dns";
import net from "net";

import { normalizeError } from "./errors.js";

export interface FetchUrlError {
  message: string;
}

// Cap on the text handed back to the agent - a tool result is part of the
// conversation's context, so an uncapped fetch of an arbitrary page could
// dump tens of thousands of tokens into it. Generous enough for a real
// README/API response, bounded enough that one bad fetch can't blow the
// context window the way an unbounded read_file/search_content result could.
export const FETCH_MAX_CHARS = 40_000;

export const FETCH_DEFAULT_TIMEOUT_MS = 15_000;

// --- SSRF guarding -----------------------------------------------------
//
// fetch_url lets the agent choose an arbitrary URL, which is exactly the
// shape of tool that can be turned into a probe of the machine's local
// network - a page the agent was asked to summarise could contain a prompt
// injection asking it to also "check" a link into a router's admin panel or
// a cloud metadata endpoint, and a naive fetch tool would just do it and
// hand the response back. The checks below are a best-effort filter against
// that class of target, not a hard security boundary: they don't defend
// against DNS rebinding (the address could change between this check and
// the actual connection a moment later), which needs hooking into the
// socket layer itself to close completely. That's more machinery than a
// locally-run, single-user CLI tool warrants - this is deliberately
// defense-in-depth, not a guarantee, and is called out as such wherever it
// matters.

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return nums as [number, number, number, number];
}

function isPrivateIpv4(ip: string): boolean {
  const parsed = parseIpv4(ip);
  if (!parsed) {
    return false;
  }
  const [a, b] = parsed;
  if (a === 0) return true; // 0.0.0.0/8 - "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 - loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 - link-local, incl. the 169.254.169.254 cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15 - benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") {
    return true; // loopback / unspecified
  }
  // fc00::/7 - unique local addresses (fc00-fdff).
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) {
    return true;
  }
  // fe80::/10 - link-local (fe80-febf).
  if (/^fe[89ab][0-9a-f]:/.test(lower)) {
    return true;
  }
  // IPv4-mapped addresses (::ffff:a.b.c.d) inherit the IPv4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    return isPrivateIpv4(mapped[1]);
  }
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
  // Not a recognisable IP at all - caller's problem, not this function's.
  return false;
}

/**
 * Parses and validates a URL before anything is fetched: only http/https,
 * and not pointed at a private/reserved address - either directly (a
 * literal IP in the URL) or via DNS (every address a hostname resolves to
 * is checked, not just the first).
 */
export async function validateFetchTarget(
  rawUrl: string
): Promise<Result<URL, FetchUrlError>> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return new Err({ message: `Invalid URL: "${rawUrl}"` });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new Err({
      message: `Unsupported scheme "${parsed.protocol}" - only http:// and https:// URLs can be fetched.`,
    });
  }

  const hostname = parsed.hostname;

  // A literal IP in the URL needs no DNS lookup - check it directly.
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return new Err({
        message: `Refusing to fetch ${hostname}: that's a private/reserved address, not a public web endpoint.`,
      });
    }
    return new Ok(parsed);
  }

  try {
    const records = await dns.promises.lookup(hostname, { all: true });
    const blocked = records.find((record) =>
      isPrivateOrReservedIp(record.address)
    );
    if (blocked) {
      return new Err({
        message: `Refusing to fetch "${hostname}": it resolves to ${blocked.address}, a private/reserved address.`,
      });
    }
  } catch (error) {
    return new Err({
      message: `Could not resolve "${hostname}": ${normalizeError(error).message}`,
    });
  }

  return new Ok(parsed);
}

// --- content handling ---------------------------------------------------

export function isBinaryContentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    /^(image|audio|video|font)\//.test(type) ||
    /application\/(octet-stream|pdf|zip|gzip|x-|vnd\.)/.test(type)
  );
}

// Only the handful of named entities that show up constantly on real web
// pages - not a complete HTML5 entity table, which runs into the thousands
// for symbols this tool has no reason to render anyway.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const code = isHex
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      if (Number.isNaN(code)) {
        return match;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Reduces an HTML document to its visible text.
 *
 * Deliberately not a "reader mode" - it doesn't try to find the main
 * content, strip navigation/boilerplate, or preserve structure beyond line
 * breaks at block-element boundaries. A JS-heavy page whose real content
 * only appears after client-side rendering will come back sparse or empty;
 * there is no fix for that short of running a real browser, which is far
 * more machinery than a text-fetching tool warrants. Good enough for
 * server-rendered pages (READMEs, docs, most API-adjacent HTML), which
 * covers what this tool is actually for.
 */
export function htmlToText(html: string): string {
  const withoutNonContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const withLineBreaks = withoutNonContent
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|table)>/gi,
      "\n"
    );

  const textOnly = withLineBreaks.replace(/<[^>]+>/g, "");
  const decoded = decodeHtmlEntities(textOnly);

  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ProcessedBody {
  content: string;
  // Set when the content was longer than FETCH_MAX_CHARS - the original
  // length, so the caller can report how much was cut.
  truncatedFrom?: number;
}

/**
 * Turns a raw response body into what the agent actually sees: HTML is
 * reduced to text, JSON is pretty-printed (a minified API response is much
 * harder to read than the same content indented), and everything is capped
 * at FETCH_MAX_CHARS. Kept separate from fetchUrl below so this - the part
 * with actual decisions in it - is testable without a network call.
 */
export function processFetchedBody(
  body: string,
  contentType: string
): ProcessedBody {
  const isHtml = contentType.toLowerCase().includes("text/html");
  let text = isHtml ? htmlToText(body) : body;

  if (!isHtml && contentType.toLowerCase().includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Header said JSON, body isn't valid JSON - show it as received
      // rather than failing the whole fetch over a formatting nicety.
    }
  }

  if (text.length > FETCH_MAX_CHARS) {
    return { content: text.slice(0, FETCH_MAX_CHARS), truncatedFrom: text.length };
  }
  return { content: text };
}

export interface FetchUrlResult extends ProcessedBody {
  finalUrl: string;
  status: number;
  contentType: string;
}

/**
 * Fetches a URL and returns its content as text, or a Result error - never
 * throws. GET only (there is no way to specify another method), http/https
 * only, and refused up front if it targets a private/reserved address (see
 * validateFetchTarget above).
 */
export async function fetchUrl(
  rawUrl: string,
  timeoutMs: number = FETCH_DEFAULT_TIMEOUT_MS
): Promise<Result<FetchUrlResult, FetchUrlError>> {
  const validated = await validateFetchTarget(rawUrl);
  if (validated.isErr()) {
    return new Err(validated.error);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: globalThis.Response;
  try {
    response = await fetch(validated.value.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Some sites refuse to serve a request with no UA at all; this
        // names the tool honestly rather than impersonating a browser.
        "User-Agent": "dustm-cli/fetch_url",
        Accept: "text/html,application/json,application/xml,text/plain,*/*",
      },
    });
  } catch (error) {
    return new Err({
      message: controller.signal.aborted
        ? `Request to ${rawUrl} timed out after ${timeoutMs}ms.`
        : `Failed to fetch ${rawUrl}: ${normalizeError(error).message}`,
    });
  } finally {
    clearTimeout(timer);
  }

  // A redirect can land somewhere the original hostname's validation never
  // saw - re-validate the address actually reached before returning
  // anything from it. This narrows the exposure rather than closing it
  // entirely: the request to the redirect target has already happened by
  // this point, but its response body is withheld from the agent if the
  // target turns out to be private.
  if (new URL(response.url).hostname !== validated.value.hostname) {
    const redirectCheck = await validateFetchTarget(response.url);
    if (redirectCheck.isErr()) {
      return new Err({
        message: `${rawUrl} redirected to ${response.url}, which was refused: ${redirectCheck.error.message}`,
      });
    }
  }

  const contentType = response.headers.get("content-type") ?? "unknown";

  if (isBinaryContentType(contentType)) {
    return new Err({
      message: `${rawUrl} returned "${contentType}", which isn't text - fetch_url only reads text-like content (HTML, JSON, plain text, XML, and similar).`,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return new Err({
      message: `Failed to read the response body from ${rawUrl}: ${normalizeError(error).message}`,
    });
  }

  const processed = processFetchedBody(body, contentType);

  return new Ok({
    finalUrl: response.url,
    status: response.status,
    contentType,
    ...processed,
  });
}
