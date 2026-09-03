import type { ExecutionHostTransport } from "./contracts";
import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { PlacementReason } from "./types";

import pino, { type Logger } from "pino";

import { getActiveAssignment, mintAssignment } from "./assignments";
import { localHost } from "./resolver";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "placement" });

// ADR-165 D2/D3: every placement re-entry (launch, resume, recover, …) mints
// the next epoch INSIDE its existing CAS claim — `tx` is the caller's
// transaction. The host is the memoized local host; resolution never runs
// DB work inside the caller's tx (the registrar has its own).
export async function mintPlacement(
  tx: Db,
  input: {
    runId: string;
    reason: PlacementReason;
    host?: ExecutionHost;
    // Resolution db when the memo is cold; defaults to the caller's tx (a
    // registrar savepoint inside the claim — rare, memoized 30 s otherwise).
    db?: Db;
    transport?: ExecutionHostTransport;
    now?: Date;
    logger?: Logger;
  },
): Promise<ExecutionAssignment> {
  const host =
    input.host ??
    (await localHost({ db: input.db ?? tx, transport: input.transport }));

  return mintAssignment(tx, {
    runId: input.runId,
    hostId: host.id,
    reason: input.reason,
    now: input.now,
    logger: input.logger,
  });
}

// ADR-165 D9 lazy assignment: a command issuer meeting a run with NO active
// assignment (pre-Stage-A row) mints epoch 1 on the local host. Deterministic
// because exactly one non-retired local host can exist. MUST be deleted in
// Stage C (recorded in ADR-165).
export async function ensureAssignment(
  db: Db,
  runId: string,
  reason: PlacementReason = "legacy_backfill",
  opts: { logger?: Logger; transport?: ExecutionHostTransport } = {},
): Promise<ExecutionAssignment> {
  const active = await getActiveAssignment(db, runId);

  if (active) return active;

  (opts.logger ?? defaultLog).warn(
    { runId, reason },
    "legacy-run-assigned-lazily",
  );

  return db.transaction((tx) =>
    mintPlacement(tx as unknown as Db, {
      runId,
      reason,
      logger: opts.logger,
      transport: opts.transport,
    }),
  );
}
