import type { Db } from "./db";
import type { SupervisorEventStreamHealth } from "@/types/platform-status";

import { and, eq, isNull, lte } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { LOCAL_DIRECT_KIND } from "./hosts";

import { executionHostPressure, executionHosts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// ADR-183 D-M0/D-M6: the host's wire token for every outbox refusal, and the
// ONE state token the manager mints wherever it decides for itself.
export const HOST_PRESSURE_REFUSAL_REASON = "event_outbox_backpressure";
export const HOST_PRESSURED_REASON = "host_pressured";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "host-pressure" });

/** The host refused a command because its outbox is behind (409 PRECONDITION).
 * A third deliverer predicate beside `isFencedError` / `isUnknownOutcome`. */
export function isHostPressureRefusal(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    err.code === "PRECONDITION" &&
    err.details?.reason === HOST_PRESSURE_REFUSAL_REASON
  );
}

/** ADR-183 amendment 2026-09-28: every outbox refusal parks its command, but
 * only a host-wide limit closes the admission fence — a `wallet` refusal is
 * one teardown's own funding. An older host names no limit: it closes. */
export function refusalClosesAdmissionFence(err: unknown): boolean {
  return (
    isHostPressureRefusal(err) &&
    (err as MaisterError).details?.outboxLimit !== "wallet"
  );
}

/** What a driver sees for a refused command: non-terminal, and naming the
 * host's reason so the park owner can tell it from any other unavailability. */
export function hostPressuredError(
  err: MaisterError,
  commandId: string,
): MaisterError {
  return new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `execution host is behind on its event outbox: ${err.message}`,
    {
      cause: err,
      details: {
        reason: HOST_PRESSURED_REASON,
        hostReason: HOST_PRESSURE_REFUSAL_REASON,
        commandId,
      },
    },
  );
}

export function isHostPressuredError(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    err.code === "EXECUTOR_UNAVAILABLE" &&
    err.details?.reason === HOST_PRESSURED_REASON
  );
}

// ADR-183 D-D3: the host's own park answers the interrupted prompt with this
// token; a route or permission-cap checkpoint never mints it (it has a manager
// owner already).
export const HOST_PARK_REJECTION_REASON = "session_checkpointed";
export const HOST_PARK_CAUSE = "outbox_pressure";

/** A command outcome (a MaisterError or a stored `last_error`) that says the
 * host's outbox pressure ended this turn: its own park, or a refused
 * admission. Positive host evidence, like `turn_lost` — never inferred. */
export function isHostPressureFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, details } = error as {
    code?: unknown;
    details?: { reason?: unknown; cause?: unknown } | null;
  };

  return (
    (code === "ACP_PROTOCOL" &&
      details?.reason === HOST_PARK_REJECTION_REASON &&
      details.cause === HOST_PARK_CAUSE) ||
    (code === "PRECONDITION" &&
      details?.reason === HOST_PRESSURE_REFUSAL_REASON) ||
    (code === "EXECUTOR_UNAVAILABLE" &&
      details?.reason === HOST_PRESSURED_REASON)
  );
}

/** Refusal writer: the refusal IS evidence of pressure, so the fence closes
 * now rather than a sweep later (W9). Idempotent; only a health sample clears. */
export async function recordHostPressureRefusal(
  db: Db,
  hostId: string,
  logger: Logger = defaultLog,
): Promise<boolean> {
  const rows = await db
    .insert(executionHostPressure)
    .values({ executionHostId: hostId, pressuredSince: new Date() })
    .onConflictDoNothing({ target: executionHostPressure.executionHostId })
    .returning({ id: executionHostPressure.executionHostId });

  if (!rows[0]) return false;
  logger.warn(
    { hostId, source: "refusal", unacknowledgedAtStart: null },
    "execution-host-pressured",
  );

  return true;
}

export type HostPressureTransition = "entered" | "held" | "cleared" | "clear";

export type HostPressureObservation = {
  hostId: string;
  transition: HostPressureTransition;
  pressuredSince: string | null;
  durationMs: number | null;
  unacknowledgedAtStart: number | null;
  episodes: number | null;
};

/** Health-sample writer: the host is the authority on whether it admits new
 * work (`newWorkRefusedBy`, ADR-183 amendment 2026-09-28; an older host: its
 * `pressured` bit), so a sample both sets and clears the record — but clears
 * only a record set before its own fetch began (`sampledAt`), never a refusal
 * it could not have seen. A host that does not report its stream is not
 * sampled at all (null). */
export async function recordHostPressureSample(input: {
  db: Db;
  hostKey: string;
  stream: Pick<
    SupervisorEventStreamHealth,
    "pressured" | "pressure" | "newWorkRefusedBy"
  >;
  sampledAt?: Date;
  now?: Date;
  logger?: Logger;
}): Promise<HostPressureObservation | null> {
  const logger = input.logger ?? defaultLog;
  const now = input.now ?? new Date();
  const sampledAt = input.sampledAt ?? now;
  const refusesNewWork =
    input.stream.newWorkRefusedBy === undefined
      ? input.stream.pressured
      : input.stream.newWorkRefusedBy !== null;

  return input.db.transaction(async (tx) => {
    const [registered] = await tx
      .select({ id: executionHosts.id })
      .from(executionHosts)
      .where(
        and(
          eq(executionHosts.hostKey, input.hostKey),
          isNull(executionHosts.retiredAt),
        ),
      )
      .for("update");

    if (!registered) {
      logger.debug(
        { hostKey: input.hostKey },
        "host pressure sample skipped: no registered host for this key",
      );

      return null;
    }
    const [record] = await tx
      .select()
      .from(executionHostPressure)
      .where(eq(executionHostPressure.executionHostId, registered.id));
    const host = {
      id: registered.id,
      pressuredSince: record?.pressuredSince ?? null,
      unacknowledgedAtStart: record?.unacknowledgedAtStart ?? null,
    };
    const episodes = input.stream.pressure?.episodes ?? null;

    if (!refusesNewWork) {
      if (host.pressuredSince === null)
        return observation(host.id, "clear", null, null, null, episodes);
      const deleted = await tx
        .delete(executionHostPressure)
        .where(
          and(
            eq(executionHostPressure.executionHostId, host.id),
            lte(executionHostPressure.pressuredSince, sampledAt),
          ),
        )
        .returning({ id: executionHostPressure.executionHostId });

      if (deleted.length === 0) {
        logger.debug(
          {
            hostId: host.id,
            pressuredSince: host.pressuredSince.toISOString(),
            sampledAt: sampledAt.toISOString(),
          },
          "host pressure record newer than the sample; kept",
        );

        return observation(
          host.id,
          "held",
          host.pressuredSince,
          Math.max(0, now.getTime() - host.pressuredSince.getTime()),
          host.unacknowledgedAtStart,
          episodes,
        );
      }
      const durationMs = Math.max(
        0,
        now.getTime() - host.pressuredSince.getTime(),
      );

      logger.info(
        { hostId: host.id, durationMs },
        "execution-host-pressure-cleared",
      );

      return observation(
        host.id,
        "cleared",
        host.pressuredSince,
        durationMs,
        host.unacknowledgedAtStart,
        episodes,
      );
    }

    const pressuredSince =
      host.pressuredSince ??
      (input.stream.pressure ? new Date(input.stream.pressure.since) : now);
    const unacknowledgedAtStart =
      host.unacknowledgedAtStart ??
      input.stream.pressure?.unacknowledgedCountAtStart ??
      null;

    if (
      host.pressuredSince === null ||
      host.unacknowledgedAtStart !== unacknowledgedAtStart
    )
      await tx
        .insert(executionHostPressure)
        .values({
          executionHostId: host.id,
          pressuredSince,
          unacknowledgedAtStart,
        })
        .onConflictDoUpdate({
          target: executionHostPressure.executionHostId,
          set: { unacknowledgedAtStart },
        });
    if (host.pressuredSince === null)
      logger.warn(
        {
          hostId: host.id,
          source: "health",
          newWorkRefusedBy: input.stream.newWorkRefusedBy ?? null,
          unacknowledgedAtStart,
        },
        "execution-host-pressured",
      );

    return observation(
      host.id,
      host.pressuredSince === null ? "entered" : "held",
      pressuredSince,
      Math.max(0, now.getTime() - pressuredSince.getTime()),
      unacknowledgedAtStart,
      episodes,
    );
  });
}

function observation(
  hostId: string,
  transition: HostPressureTransition,
  pressuredSince: Date | null,
  durationMs: number | null,
  unacknowledgedAtStart: number | null,
  episodes: number | null,
): HostPressureObservation {
  return {
    hostId,
    transition,
    pressuredSince: pressuredSince?.toISOString() ?? null,
    durationMs,
    unacknowledgedAtStart,
    episodes,
  };
}

/** The admission fence's read: when the local host is pressured. Read under
 * whatever lock the caller already holds. */
export async function localHostPressuredSince(db: Db): Promise<Date | null> {
  const [host] = await db
    .select({ pressuredSince: executionHostPressure.pressuredSince })
    .from(executionHostPressure)
    .innerJoin(
      executionHosts,
      eq(executionHosts.id, executionHostPressure.executionHostId),
    )
    .where(
      and(
        eq(executionHosts.kind, LOCAL_DIRECT_KIND),
        isNull(executionHosts.retiredAt),
      ),
    )
    .limit(1);

  return host?.pressuredSince ?? null;
}
