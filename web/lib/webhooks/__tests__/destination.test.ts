import { createServer } from "node:http";
import { type AddressInfo } from "node:net";

import { fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";

import {
  assertAllowedDestinationUrl,
  isBlockedAddress,
  pinnedDispatcher,
  resolveAllowedDestination,
} from "@/lib/webhooks/destination";
import { isMaisterError } from "@/lib/errors";

// =============================================================================
// SSRF egress policy (codex finding #3, ADR-076). Table-driven classification
// of blocked vs public destinations, the write-time URL assertion, the
// send-time resolver (incl. a hostname resolving to loopback — the
// rebind-shaped case), and the MAISTER_WEBHOOK_ALLOW_HOSTS operator override.
// =============================================================================

const BLOCKED_ADDRESSES = [
  // loopback
  "127.0.0.1",
  "127.255.255.254",
  "::1",
  // private
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.254",
  "192.168.1.1",
  "fc00::1",
  "fd12:3456:789a::1",
  // link-local + cloud metadata
  "169.254.0.1",
  "169.254.169.254",
  "fe80::1",
  // multicast
  "224.0.0.1",
  "239.255.255.255",
  "ff02::1",
  // unspecified / this-network
  "0.0.0.0",
  "::",
  // IPv4-mapped IPv6 must classify by the embedded v4
  "::ffff:127.0.0.1",
  "::ffff:10.1.2.3",
];

const PUBLIC_ADDRESSES = [
  "93.184.216.34",
  "8.8.8.8",
  "1.1.1.1",
  "172.15.255.254",
  "172.32.0.1",
  "2606:4700:4700::1111",
  "::ffff:8.8.8.8",
];

describe("isBlockedAddress", () => {
  it.each(BLOCKED_ADDRESSES)("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(PUBLIC_ADDRESSES)("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("treats a non-IP string as not-an-address", () => {
    expect(isBlockedAddress("example.com")).toBe(false);
  });
});

describe("assertAllowedDestinationUrl (write-time)", () => {
  it.each([
    "http://127.0.0.1/hook",
    "http://10.0.0.5:8080/hook",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/hook",
    "http://192.168.0.10/hook",
  ])("rejects the IP-literal destination %s with CONFIG", (url) => {
    let caught: unknown;

    try {
      assertAllowedDestinationUrl(new URL(url), {});
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("CONFIG");
  });

  it.each([
    "https://hooks.example.com/maister",
    "https://8.8.8.8/hook",
    "http://example.internal/hook",
  ])("accepts %s (hostnames defer to send-time resolution)", (url) => {
    expect(() => assertAllowedDestinationUrl(new URL(url), {})).not.toThrow();
  });

  it("lets an allowlisted blocked literal through", () => {
    expect(() =>
      assertAllowedDestinationUrl(new URL("http://127.0.0.1:9999/hook"), {
        MAISTER_WEBHOOK_ALLOW_HOSTS: "127.0.0.1",
      }),
    ).not.toThrow();
  });
});

describe("resolveAllowedDestination (send-time)", () => {
  it("blocks a blocked IP literal without resolving", async () => {
    const result = await resolveAllowedDestination("169.254.169.254", {});

    expect(result.ok).toBe(false);
    expect(result.addresses).toBeUndefined();
  });

  it("allows a public IP literal without resolving (no pin needed)", async () => {
    const result = await resolveAllowedDestination("93.184.216.34", {});

    expect(result.ok).toBe(true);
    expect(result.addresses).toBeUndefined();
  });

  it("blocks a hostname resolving to loopback (rebind-shaped)", async () => {
    // `localhost` is the universally present hostname-with-private-records:
    // it passes the write-time IP-literal check but must be refused here.
    const result = await resolveAllowedDestination("localhost", {});

    expect(result.ok).toBe(false);
  });

  it("blocks a hostname that does not resolve", async () => {
    const result = await resolveAllowedDestination("no-such-host.invalid", {});

    expect(result.ok).toBe(false);
  });

  it("returns the vetted addresses for a resolvable public hostname", async () => {
    // dns.lookup honors /etc/hosts only for mapped names; for a stable
    // network-free case, an allowlisted host short-circuits instead.
    const allow = await resolveAllowedDestination("localhost", {
      MAISTER_WEBHOOK_ALLOW_HOSTS: "localhost,internal.example",
    });

    expect(allow.ok).toBe(true);
    expect(allow.addresses).toBeUndefined();
  });

  it("matches the allowlist case-insensitively and trims entries", async () => {
    const result = await resolveAllowedDestination("LocalHost", {
      MAISTER_WEBHOOK_ALLOW_HOSTS: " localhost , other.example ",
    });

    expect(result.ok).toBe(true);
  });
});

describe("pinnedDispatcher", () => {
  it("connects to the pinned address regardless of the request hostname", async () => {
    const server = createServer((_req, res) => {
      res.end("pinned-ok");
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;

    // `.invalid` never resolves in DNS — the request can only succeed if the
    // connector used the pinned address instead of a live lookup.
    const dispatcher = pinnedDispatcher([{ address: "127.0.0.1", family: 4 }]);

    try {
      const res = await undiciFetch(`http://pinned-host.invalid:${port}/`, {
        dispatcher,
      });

      expect(await res.text()).toBe("pinned-ok");
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
