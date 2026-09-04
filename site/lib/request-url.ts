import type { NextRequest } from "next/server";

import { siteUrl } from "@/lib/site-config";

/**
 * Resolve the origin the *client* used, not the one the server bound to.
 *
 * In a standalone Next build the server listens on HOSTNAME=0.0.0.0, so
 * `request.url` is `http://0.0.0.0:3001/...`. Deriving a redirect target from
 * it (`new URL("/en", request.url)`) emits an absolute Location pointing at an
 * address no browser can reach. Behind the reverse proxy we must reconstruct
 * the public origin from the forwarding headers instead.
 *
 * Precedence:
 *   1. X-Forwarded-Proto / X-Forwarded-Host (what the edge actually served)
 *   2. Host header (direct hit, no proxy)
 *   3. NEXT_PUBLIC_SITE_URL (build-time fallback)
 */
export function resolveRequestOrigin(request: NextRequest): string {
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"))
    ?? request.headers.get("host");

  if (forwardedHost && !isUnroutableHost(forwardedHost)) {
    const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"))
      ?? request.nextUrl.protocol.replace(":", "")
      ?? "https";

    return `${forwardedProto}://${forwardedHost}`;
  }

  return siteUrl().origin;
}

/** Build an absolute URL for `path` on the origin the client actually used. */
export function absoluteUrl(request: NextRequest, path: string): URL {
  return new URL(path, resolveRequestOrigin(request));
}

/** `X-Forwarded-*` may carry a comma-separated chain; the client-facing value is first. */
function firstHeaderValue(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();

  return first ? first : undefined;
}

/** Hosts a browser can never follow — the exact trap this module exists to avoid. */
function isUnroutableHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

  return hostname === "0.0.0.0" || hostname === "::" || hostname === "";
}
