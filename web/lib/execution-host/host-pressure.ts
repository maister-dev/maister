import type { Db } from "./db";
import type { SupervisorEventStreamHealth } from "@/types/platform-status";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { LOCAL_DIRECT_KIND } from "./hosts";

import { executionHosts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// ADR-183 D-M0/D-M6: the host's wire token for a soft/hard outbox refusal, and
// the ONE state token the manager mints wherever it decides for itself.
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

/** Refusal writer: the refusal IS evidence of pressure, so the fence closes
 * now rather than a sweep later (W9). Idempotent; only a health sample clears. */
export async function recordHostPressureRefusal(
  db: Db,
  hostId: string,
  logger: Logger = defaultLog,
): Promise<boolean> {
  const rows = await db
    .update(executionHosts)
    .set({ pressuredSince: new Date() })
    .where(
      and(eq(executionHosts.id, hostId), isNull(executionHosts.pressuredSince)),
    )
    .returning({ id: executionHosts.id });

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

/** Health-sample writer: the host is the authority on pressure, so a sample
 * both sets and clears the record. A host that does not report its stream is
 * not sampled at all (null). */
export async function recordHostPressureSample(input: {
  db: Db;
  hostKey: string;
  stream: Pick<SupervisorEventStreamHealth, "pressured" | "pressure">;
  now?: Date;
  logger?: Logger;
}): Promise<HostPressureObservation | null> {
  const logger = input.logger ?? defaultLog;
  const now = input.now ?? new Date();

  return input.db.transaction(async (tx) => {
    const [host] = await tx
      .select({
        id: executionHosts.id,
        pressuredSince: executionHosts.pressuredSince,
        unacknowledgedAtStart: executionHosts.pressureUnacknowledgedAtStart,
      })
      .from(executionHosts)
      .where(
        and(
          eq(executionHosts.hostKey, input.hostKey),
          isNull(executionHosts.retiredAt),
        ),
      )
      .for("update");

    if (!host) {
      logger.debug(
        { hostKey: input.hostKey },
        "host pressure sample skipped: no registered host for this key",
      );

      return null;
    }
    const episodes = input.stream.pressure?.episodes ?? null;

    if (!input.stream.pressured) {
      if (host.pressuredSince === null)
        return observation(host.id, "clear", null, null, null, episodes);
      await tx
        .update(executionHosts)
        .set({ pressuredSince: null, pressureUnacknowledgedAtStart: null })
        .where(eq(executionHosts.id, host.id));
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
        .update(executionHosts)
        .set({
          pressuredSince,
          pressureUnacknowledgedAtStart: unacknowledgedAtStart,
        })
        .where(eq(executionHosts.id, host.id));
    if (host.pressuredSince === null)
      logger.warn(
        { hostId: host.id, source: "health", unacknowledgedAtStart },
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
    .select({ pressuredSince: executionHosts.pressuredSince })
    .from(executionHosts)
    .where(
      and(
        eq(executionHosts.kind, LOCAL_DIRECT_KIND),
        isNull(executionHosts.retiredAt),
        isNotNull(executionHosts.pressuredSince),
      ),
    )
    .limit(1);

  return host?.pressuredSince ?? null;
}
