import type { ExecutionHostTransport } from "./contracts";
import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { PlacementReason } from "./types";

import { eq } from "drizzle-orm";
import pino, { type Logger } from "pino";

import {
  getActiveAssignment,
  getLatestAssignment,
  mintAssignment,
} from "./assignments";
import { localHost } from "./resolver";

import { runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "placement" });

// ADR-166 D2/D3: every placement re-entry (launch, resume, recover, …) mints
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

// ADR-166 D9 lazy assignment: a command issuer meeting a run that was NEVER
// placed (pre-ADR-166 row, no assignment history) mints epoch 1 on the local
// host. Deterministic because exactly one non-retired local host can exist.
// A run WITH history and no active assignment is a placement bug, not a legacy
// row: its re-entry must mint inside its own claim, so the issuer is refused.
// The re-check runs under the run row's lock — a concurrent issuer that minted
// first is reused, never superseded. MUST be deleted in Stage C (ADR-166).
export async function ensureAssignment(
  db: Db,
  runId: string,
  reason: PlacementReason = "legacy_backfill",
  opts: { logger?: Logger; transport?: ExecutionHostTransport } = {},
): Promise<ExecutionAssignment> {
  const active = await getActiveAssignment(db, runId);

  if (active) return active;

  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;

    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    const current = await getActiveAssignment(tx, runId);

    if (current) return current;

    const latest = await getLatestAssignment(tx, runId);

    if (latest) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} has no active execution assignment (its latest, ${latest.id}, is ${latest.state}); the re-entry must mint its placement before addressing the host`,
        {
          details: {
            reason: "assignment_missing",
            runId,
            assignmentId: latest.id,
            assignmentState: latest.state,
          },
        },
      );
    }

    (opts.logger ?? defaultLog).warn(
      { runId, reason },
      "legacy-run-assigned-lazily",
    );

    return mintPlacement(tx, {
      runId,
      reason,
      logger: opts.logger,
      transport: opts.transport,
    });
  });
}
