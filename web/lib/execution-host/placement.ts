import type { ExecutionHostTransport } from "./contracts";
import type { Db } from "./db";
import type { ExecutionAssignment, ExecutionHost } from "@/lib/db/schema";
import type { PlacementReason } from "./types";

import { and, eq, isNull } from "drizzle-orm";
import pino, { type Logger } from "pino";

import {
  getActiveAssignment,
  getLatestAssignment,
  mintAssignment,
} from "./assignments";
import { localHost } from "./resolver";

import { executionHosts, runs, workspaces } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "placement" });

// ADR-166 D2/D3: every placement re-entry (launch, resume, recover, …) mints
// the next epoch inside its existing CAS claim. Addressed workspaces inherit
// their original host, including when the deployment default changes.
export async function mintPlacement(
  tx: Db,
  input: {
    runId: string;
    reason: PlacementReason;
    host?: ExecutionHost;
    db?: Db;
    transport?: ExecutionHostTransport;
    now?: Date;
    logger?: Logger;
  },
): Promise<ExecutionAssignment> {
  const [owner] = await tx
    .select({ host: executionHosts })
    .from(workspaces)
    .innerJoin(
      executionHosts,
      eq(executionHosts.id, workspaces.executionHostId),
    )
    .where(
      and(
        eq(workspaces.runId, input.runId),
        eq(workspaces.ownershipKind, "host_owned"),
        isNull(workspaces.removedAt),
      ),
    )
    .limit(1);
  if (owner?.host.retiredAt)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The prepared workspace's execution host is retired",
    );
  if (owner && input.host && input.host.id !== owner.host.id)
    throw new MaisterError(
      "CONFLICT",
      "The prepared workspace belongs to another execution host",
      {
        details: { reason: "workspace_preparation_changed" },
      },
    );
  const host = owner?.host ?? input.host ??
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
// default host. ADR-219 keeps this bridge for legacy, never-placed Runs.
// A run WITH history and no active assignment is a placement bug, not a legacy
// row: its re-entry must mint inside its own claim, so the issuer is refused.
// The re-check runs under the run row's lock — a concurrent issuer that minted
// first is reused. Addressed launches commit their assignment before delivery.
export async function ensureAssignment(
  db: Db,
  runId: string,
  reason: PlacementReason = "legacy_backfill",
  opts: { logger?: Logger; transport?: ExecutionHostTransport } = {},
): Promise<ExecutionAssignment> {
  const active = await getActiveAssignment(db, runId);

  if (active) return active;
  // Resolve and activate the local data plane on the caller's durable DB
  // before entering the run-claim transaction. A background event consumer
  // must never retain a transaction-scoped Drizzle handle after commit.
  const host = await localHost({ db, transport: opts.transport });

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
      host,
      logger: opts.logger,
    });
  });
}
