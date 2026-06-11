import "server-only";

import type { LookupAddress } from "node:dns";

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { Agent, type Dispatcher } from "undici";

import { MaisterError } from "@/lib/errors";

type WebhookEnv = Record<string, string | undefined>;

// Egress policy (ADR-076): an outbound webhook destination must not reach
// loopback, private, link-local (incl. the cloud metadata endpoint
// 169.254.169.254), multicast, or unspecified addresses — a member-created
// subscription or ping must not become a read primitive against IMDS or
// intra-host services (the truncated response snippet is persisted and
// readable). MAISTER_WEBHOOK_ALLOW_HOSTS (comma-separated exact hosts) lets
// the operator exempt known-internal endpoints (e.g. 127.0.0.1 in local dev).
// BlockList classifies IPv4-mapped IPv6 by the embedded IPv4 address.
const BLOCKED = new BlockList();

BLOCKED.addSubnet("0.0.0.0", 8, "ipv4"); // unspecified / this-network
BLOCKED.addSubnet("10.0.0.0", 8, "ipv4"); // private
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. metadata
BLOCKED.addSubnet("172.16.0.0", 12, "ipv4"); // private
BLOCKED.addSubnet("192.168.0.0", 16, "ipv4"); // private
BLOCKED.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
BLOCKED.addAddress("::", "ipv6"); // unspecified
BLOCKED.addAddress("::1", "ipv6"); // loopback
BLOCKED.addSubnet("fc00::", 7, "ipv6"); // unique-local (private)
BLOCKED.addSubnet("fe80::", 10, "ipv6"); // link-local
BLOCKED.addSubnet("ff00::", 8, "ipv6"); // multicast

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 0) return false;

  return BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

// URL.hostname wraps an IPv6 literal in brackets — strip them for isIP checks.
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isAllowlistedHost(host: string, env: WebhookEnv): boolean {
  const raw = env.MAISTER_WEBHOOK_ALLOW_HOSTS ?? "";
  const entries = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);

  return entries.includes(host.toLowerCase());
}

// Write-time guard (subscription create/update): rejects an IP-literal
// destination in a blocked range with CONFIG → 422. Hostnames pass here —
// their addresses are only knowable at send time, where
// resolveAllowedDestination re-checks every resolved record.
export function assertAllowedDestinationUrl(
  url: URL,
  env: WebhookEnv = process.env,
): void {
  const host = bareHost(url.hostname);

  if (isAllowlistedHost(host, env)) return;

  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new MaisterError(
      "CONFIG",
      `webhook url host "${host}" is a blocked destination (loopback/private/link-local/metadata addresses are not allowed)`,
    );
  }
}

export interface ResolvedDestination {
  ok: boolean;
  reason?: string;
  // DNS-resolved records, present only for hostname destinations — the send
  // pins its connect to exactly this vetted set (closes the rebind TOCTOU).
  addresses?: LookupAddress[];
}

// Send-time guard: classifies the destination just before the wire. An IP
// literal is checked directly; a hostname is resolved (system resolver, all
// records) and refused if ANY answer lands in a blocked range.
export async function resolveAllowedDestination(
  hostname: string,
  env: WebhookEnv = process.env,
): Promise<ResolvedDestination> {
  const host = bareHost(hostname);

  if (isAllowlistedHost(host, env)) return { ok: true };

  if (isIP(host) !== 0) {
    return isBlockedAddress(host)
      ? {
          ok: false,
          reason: `destination "${host}" is blocked by the egress policy`,
        }
      : { ok: true };
  }

  let addresses: LookupAddress[];

  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    return { ok: false, reason: `destination "${host}" did not resolve` };
  }

  if (
    addresses.length === 0 ||
    addresses.some((a) => isBlockedAddress(a.address))
  ) {
    return {
      ok: false,
      reason: `destination "${host}" resolves to a blocked address (egress policy)`,
    };
  }

  return { ok: true, addresses };
}

// undici Agent whose connector answers lookups from the already-vetted
// addresses instead of re-querying DNS — the connect-time answer cannot differ
// from the checked one. TLS SNI/cert validation still uses the hostname.
export function pinnedDispatcher(addresses: LookupAddress[]): Dispatcher {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, addresses);
      },
    },
  });
}
