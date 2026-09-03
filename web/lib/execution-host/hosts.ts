import type { Db } from "./db";
import type { ExecutionHostReadiness } from "./types";

import { randomUUID } from "node:crypto";

import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import pino, { type Logger } from "pino";

import {
  executionAssignments,
  executionHosts,
  runs,
  type ExecutionHost,
} from "@/lib/db/schema";

export const LOCAL_DIRECT_KIND = "local_direct" as const;

// Run statuses under which an `active` assignment means a live driver owns the
// run on its host. Everything else (parked, review, terminal, crashed) has no
// live driver: the sweep releases such assignments and a new host may register.
export const LIVE_DRIVER_RUN_STATUSES = ["Running", "NeedsInput"] as const;

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "hosts" });

export type HostCapabilities = {
  protocolVersion: number;
  supervisorVersion: string;
  adapters: string[];
};

export async function findActiveLocalHost(
  db: Db,
): Promise<ExecutionHost | null> {
  const rows = await db
    .select()
    .from(executionHosts)
    .where(
      and(
        eq(executionHosts.kind, LOCAL_DIRECT_KIND),
        isNull(executionHosts.retiredAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// Serializes the registrar's identity-change policy: lock → verify → commit.
export async function lockActiveLocalHost(
  tx: Db,
): Promise<ExecutionHost | null> {
  const rows = await tx
    .select()
    .from(executionHosts)
    .where(
      and(
        eq(executionHosts.kind, LOCAL_DIRECT_KIND),
        isNull(executionHosts.retiredAt),
      ),
    )
    .for("update")
    .limit(1);

  return rows[0] ?? null;
}

export async function getHostById(
  db: Db,
  id: string,
): Promise<ExecutionHost | null> {
  const rows = await db
    .select()
    .from(executionHosts)
    .where(eq(executionHosts.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function insertLocalHost(
  tx: Db,
  input: {
    hostKey: string;
    bootId: string;
    capabilities: HostCapabilities;
    displayName?: string;
    now?: Date;
    logger?: Logger;
  },
): Promise<ExecutionHost> {
  const now = input.now ?? new Date();
  const [row] = await tx
    .insert(executionHosts)
    .values({
      id: randomUUID(),
      hostKey: input.hostKey,
      kind: LOCAL_DIRECT_KIND,
      displayName: input.displayName ?? "local supervisor",
      transport: { kind: LOCAL_DIRECT_KIND },
      capabilities: input.capabilities,
      readiness: "ready",
      readinessReason: null,
      lastBootId: input.bootId,
      lastSeenAt: now,
      registeredAt: now,
      updatedAt: now,
    })
    .returning();

  (input.logger ?? defaultLog).info(
    { hostId: row.id, hostKey: row.hostKey, bootId: input.bootId },
    "execution-host-registered",
  );

  return row;
}

export async function touchLocalHost(
  tx: Db,
  id: string,
  patch: {
    bootId: string;
    capabilities: HostCapabilities;
    now?: Date;
  },
): Promise<ExecutionHost | null> {
  const now = patch.now ?? new Date();
  const [row] = await tx
    .update(executionHosts)
    .set({
      lastBootId: patch.bootId,
      capabilities: patch.capabilities,
      readiness: "ready",
      readinessReason: null,
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(executionHosts.id, id))
    .returning();

  return row ?? null;
}

export async function markHostReadiness(
  db: Db,
  id: string,
  readiness: ExecutionHostReadiness,
  reason: string | null,
  now: Date = new Date(),
): Promise<ExecutionHost | null> {
  const [row] = await db
    .update(executionHosts)
    .set({ readiness, readinessReason: reason, updatedAt: now })
    .where(eq(executionHosts.id, id))
    .returning();

  return row ?? null;
}

export async function retireHost(
  tx: Db,
  id: string,
  now: Date = new Date(),
  logger: Logger = defaultLog,
): Promise<ExecutionHost | null> {
  const [row] = await tx
    .update(executionHosts)
    .set({ retiredAt: now, updatedAt: now })
    .where(and(eq(executionHosts.id, id), isNull(executionHosts.retiredAt)))
    .returning();

  if (row) {
    logger.warn(
      { hostId: row.id, hostKey: row.hostKey },
      "execution-host-retired-idle",
    );
  }

  return row ?? null;
}

// Does this host still own an `active` assignment of a run with a live driver?
// The registrar refuses an identity change while the answer is non-zero.
export async function countLiveAssignmentsForHost(
  db: Db,
  hostId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(executionAssignments)
    .innerJoin(runs, eq(runs.id, executionAssignments.runId))
    .where(
      and(
        eq(executionAssignments.executionHostId, hostId),
        eq(executionAssignments.state, "active"),
        inArray(runs.status, [...LIVE_DRIVER_RUN_STATUSES]),
      ),
    );

  return Number(row?.n ?? 0);
}

export async function listLiveRunIdsForHost(
  db: Db,
  hostId: string,
  limit = 20,
): Promise<string[]> {
  const rows = await db
    .select({ runId: executionAssignments.runId })
    .from(executionAssignments)
    .innerJoin(runs, eq(runs.id, executionAssignments.runId))
    .where(
      and(
        eq(executionAssignments.executionHostId, hostId),
        eq(executionAssignments.state, "active"),
        inArray(runs.status, [...LIVE_DRIVER_RUN_STATUSES]),
      ),
    )
    .orderBy(sql`${runs.startedAt} asc`)
    .limit(limit);

  return rows.map((r) => r.runId);
}
