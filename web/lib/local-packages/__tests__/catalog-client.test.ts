import { MockAgent } from "undici";
import { afterEach, expect, it, vi } from "vitest";

import { jsonFromCatalog } from "@/lib/local-packages/catalog-client";
import {
  pinnedDispatcher,
  resolveAllowedDestination,
} from "@/lib/webhooks/destination";

vi.mock("@/lib/webhooks/destination", () => ({
  pinnedDispatcher: vi.fn(),
  resolveAllowedDestination: vi.fn(),
}));

const catalog = new URL("https://api.github.com/catalog");
const addresses = [{ address: "192.0.2.10", family: 4 }];

afterEach(() => vi.resetAllMocks());

function response(
  status: number,
  body: string,
  headers?: Record<string, string>,
): MockAgent {
  const wire = new MockAgent();

  wire.disableNetConnect();
  wire
    .get(catalog.origin)
    .intercept({ path: catalog.pathname })
    .reply(status, body, { headers });
  vi.mocked(resolveAllowedDestination).mockResolvedValue({
    ok: true,
    addresses,
  });
  vi.mocked(pinnedDispatcher).mockReturnValueOnce(wire);

  return wire;
}

it("IT-CAT-01 rejects unapproved URLs and unsafe DNS before opening a catalog transport", async () => {
  for (const url of [
    "http://api.github.com/catalog",
    "https://example.com/catalog",
    "https://user@api.github.com/catalog",
    "https://api.github.com:8443/catalog",
  ]) {
    await expect(jsonFromCatalog(new URL(url))).rejects.toMatchObject({
      status: 422,
    });
  }
  expect(resolveAllowedDestination).not.toHaveBeenCalled();
  vi.mocked(resolveAllowedDestination).mockResolvedValue({ ok: false });
  await expect(jsonFromCatalog(catalog)).rejects.toMatchObject({ status: 503 });
  expect(resolveAllowedDestination).toHaveBeenCalledWith(catalog.hostname, {});
  expect(pinnedDispatcher).not.toHaveBeenCalled();
});

it.each<{
  name: string;
  status: number;
  headers: Record<string, string>;
  refused: number;
}>([
  {
    name: "redirect",
    status: 302,
    headers: { location: "https://registry.npmjs.org/" },
    refused: 422,
  },
  {
    name: "provider rate limit",
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
    refused: 429,
  },
])(
  "IT-CAT-01 refuses $name without opening another connection",
  async ({ status, headers, refused }) => {
    const wire = response(status, "", headers);

    await expect(jsonFromCatalog(catalog)).rejects.toMatchObject({
      status: refused,
    });
    wire.assertNoPendingInterceptors();
    expect(pinnedDispatcher).toHaveBeenCalledExactlyOnceWith(addresses);
  },
);

it("IT-CAT-01 rejects oversized catalog metadata while reading response bytes", async () => {
  response(200, "x".repeat(4 * 1024 * 1024 + 1));

  await expect(jsonFromCatalog(catalog)).rejects.toMatchObject({
    status: 422,
    message: "Catalog metadata exceeds the 4 MiB limit",
  });
  expect(pinnedDispatcher).toHaveBeenCalledTimes(1);
});

it.each([401, 403])(
  "reports source HTTP %i as public access denial",
  async (status) => {
    const wire = response(status, "upstream diagnostic");

    await expect(jsonFromCatalog(catalog)).rejects.toMatchObject({
      status: 422,
      code: "CONFIG",
      details: { reason: "upstream_access_denied" },
    });
    wire.assertNoPendingInterceptors();
  },
);

it("IT-CAT-01 retries a transient catalog response through a fresh pinned dispatcher", async () => {
  const unavailable = response(503, "unavailable");
  const recovered = response(200, '{"available":true}');

  await expect(jsonFromCatalog(catalog)).resolves.toEqual({ available: true });
  expect(resolveAllowedDestination).toHaveBeenCalledTimes(2);
  unavailable.assertNoPendingInterceptors();
  recovered.assertNoPendingInterceptors();
});

it("IT-CAT-01 cancels an upstream request and stops retrying it", async () => {
  const controller = new AbortController();
  const cancelled = new Error("Search replaced");
  const wire = new MockAgent();

  wire.disableNetConnect();
  wire
    .get(catalog.origin)
    .intercept({ path: catalog.pathname })
    .reply(() => {
      setImmediate(() => controller.abort(cancelled));

      return { statusCode: 503, data: "unavailable" };
    })
    .delay(1000);
  vi.mocked(resolveAllowedDestination).mockResolvedValue({
    ok: true,
    addresses,
  });
  vi.mocked(pinnedDispatcher).mockReturnValueOnce(wire);

  await expect(jsonFromCatalog(catalog, controller.signal)).rejects.toBe(
    cancelled,
  );
  expect(pinnedDispatcher).toHaveBeenCalledExactlyOnceWith(addresses);
  wire.assertNoPendingInterceptors();
});
