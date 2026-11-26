import "server-only";

import type { CatalogFailureDetails } from "./catalog-contract";

import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";
import { fetch as fetchPublic } from "undici";

import { MaisterError } from "@/lib/errors";
import {
  pinnedDispatcher,
  resolveAllowedDestination,
} from "@/lib/webhooks/destination";

const log = pino({
  name: "studio-catalog",
  level: process.env.LOG_LEVEL ?? "info",
});
const hosts = new Set([
  "api.github.com",
  "registry.modelcontextprotocol.io",
  "registry.npmjs.org",
]);

export type CatalogClient = (url: URL) => Promise<unknown>;

export class CatalogError extends MaisterError {
  constructor(
    readonly status: number,
    message: string,
    details?: CatalogFailureDetails,
  ) {
    super(
      status === 409
        ? "CONFLICT"
        : status === 503 || status === 429
          ? "EXECUTOR_UNAVAILABLE"
          : "CONFIG",
      message,
      { details },
    );
    Object.setPrototypeOf(this, CatalogError.prototype);
  }
}

export const jsonFromCatalog: CatalogClient = async (url) => {
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new CatalogError(422, "Unsupported catalog address");
  }
  for (let attempt = 1; ; attempt++) {
    const destination = await resolveAllowedDestination(url.hostname, {});

    if (!destination.ok || !destination.addresses?.length)
      throw new CatalogError(
        503,
        "Catalog DNS did not resolve to public addresses",
      );
    const dispatcher = pinnedDispatcher(destination.addresses);

    try {
      const response = await fetchPublic(url, {
        dispatcher,
        headers: {
          accept: "application/json",
          "user-agent": "MAIster-Studio-Catalog",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;

        if (
          status === 429 ||
          (status === 403 &&
            response.headers.get("x-ratelimit-remaining") === "0")
        )
          throw new CatalogError(429, "Catalog source rate limit reached");
        if (status >= 300 && status < 400)
          throw new CatalogError(422, "Catalog redirects are unsupported");
        if (status === 404)
          throw new CatalogError(404, "Catalog item unavailable");
        if (status === 401 || status === 403)
          throw new CatalogError(422, "Catalog source refused public access", {
            reason: "upstream_access_denied",
          });
        throw new CatalogError(
          status >= 500 ? 503 : 422,
          `Catalog source returned HTTP ${status}`,
        );
      }
      const reader = response.body?.getReader();

      if (!reader) throw new CatalogError(503, "Empty source response");
      const chunks: Uint8Array[] = [];
      let size = 0;

      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new CatalogError(
            422,
            "Catalog metadata exceeds the 4 MiB limit",
          );
        }
        chunks.push(value);
      }
      try {
        return JSON.parse(
          Buffer.concat(chunks.map((v) => Buffer.from(v))).toString("utf8"),
        ) as unknown;
      } catch {
        throw new CatalogError(422, "Catalog returned invalid JSON");
      }
    } catch (error) {
      if (error instanceof CatalogError && error.status !== 503) throw error;
      log.warn({ source: url.hostname, attempt }, "Catalog request failed");
      if (attempt >= 2)
        throw error instanceof CatalogError
          ? error
          : new CatalogError(503, "Catalog source unavailable");
      await delay(150);
    } finally {
      await dispatcher.close();
    }
  }
};
