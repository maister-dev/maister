import "server-only";

import type { ExecutionHost } from "@/lib/db/schema";
import type { EnsureLocalHostOptions, RegistrationResult } from "./registrar";

import pino from "pino";

import { defaultTransport } from "./default-transport";
import { startRuntimeEventConsumer } from "./events/consumer";
import { ensureLocalExecutionHost } from "./registrar";

import { getDb } from "@/lib/db/client";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "event-plane" });

function supportsRuntimeEventStream(
  host: Pick<ExecutionHost, "capabilities">,
): boolean {
  const capabilities = host.capabilities;

  if (!capabilities || typeof capabilities !== "object") return false;
  const dataPlane = (capabilities as Record<string, unknown>).dataPlane;

  return (
    Boolean(dataPlane) &&
    typeof dataPlane === "object" &&
    (dataPlane as Record<string, unknown>).eventStream === true
  );
}

// Registration and canonical event ingestion form one local data-plane
// activation. Keeping the operation idempotent lets boot, lazy resolution,
// and the periodic recovery sweep all close the web-first upgrade window.
export async function ensureLocalExecutionDataPlane(
  opts: EnsureLocalHostOptions = {},
): Promise<RegistrationResult> {
  const db = opts.db ?? getDb();
  const transport = opts.transport ?? defaultTransport();
  const logger = opts.logger ?? defaultLog;
  const result = await ensureLocalExecutionHost({
    ...opts,
    db,
    transport,
    logger,
  });

  if (
    result.status === "registered" &&
    supportsRuntimeEventStream(result.host)
  ) {
    startRuntimeEventConsumer({
      db,
      executionHostId: result.host.id,
      transport,
      logger,
    });
  }

  return result;
}
