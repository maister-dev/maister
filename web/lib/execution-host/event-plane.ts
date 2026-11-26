import "server-only";

import type { ExecutionHost } from "@/lib/db/schema";
import type { EnsureLocalHostOptions, RegistrationResult } from "./registrar";
import type { AdditionalExecutionEndpoint } from "./selected-endpoint";

import pino from "pino";

import { defaultTransport, pinnedExecutionHostTransport } from "./default-transport";
import { startRuntimeEventConsumer } from "./events/consumer";
import { ensureAdditionalExecutionHost, ensureLocalExecutionHost } from "./registrar";
import { configuredAdditionalExecutionEndpoints } from "./selected-endpoint";

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

export async function ensureAdditionalExecutionDataPlane(
  peer: AdditionalExecutionEndpoint,
  opts: EnsureLocalHostOptions,
): Promise<RegistrationResult> {
  const db = opts.db ?? getDb();
  const logger = opts.logger ?? defaultLog;
  const transport = pinnedExecutionHostTransport(peer);
  const result = await ensureAdditionalExecutionHost(peer, { ...opts, db, logger, transport });
  if (result.status === "registered" && supportsRuntimeEventStream(result.host))
    startRuntimeEventConsumer({ db, executionHostId: result.host.id, transport, logger });
  return result;
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
  const activate = (result: RegistrationResult, plane: ReturnType<typeof defaultTransport>): void => {
    if (result.status === "registered" && supportsRuntimeEventStream(result.host))
      startRuntimeEventConsumer({
        db, executionHostId: result.host.id, transport: plane, logger,
      });
  };
  const peers = configuredAdditionalExecutionEndpoints();
  const primary = ensureLocalExecutionHost({
    ...opts,
    db,
    transport,
    logger,
  }).then((result) => {
    activate(result, transport);
    return result;
  });
  const [result] = await Promise.all([
    primary,
    ...peers.map((peer) => ensureAdditionalExecutionDataPlane(peer, { ...opts, db, logger })),
  ]);
  return result;
}
