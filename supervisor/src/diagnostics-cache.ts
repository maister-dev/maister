// ADR-224 — the snapshot policy behind supervisor `GET /diagnostics`.
//
// Pure policy: it owns the clock reads, generations and in-flight bookkeeping
// but knows nothing about adapters, the filesystem or HTTP. The route injects
// `compute` (the host probe) and `sourceVersion` (the smoke-cache mtime).
// Rules DIAG-01…DIAG-09 live in docs/system-analytics/host-diagnostics.md.
import type { Logger } from "pino";

export type DiagnosticsCacheLogger = Pick<Logger, "debug" | "info" | "warn">;

export type DiagnosticsCacheOptions<T> = {
  /** Age below which a snapshot is returned as is. */
  ttlMs: number;
  /** Age below which a snapshot is returned while one recompute runs. */
  staleWhileRevalidateMs: number;
  now: () => number;
  /** Probes the host. Receives the probe start time it must report. */
  compute: (startedAt: number) => Promise<T>;
  /** Identity of the inputs a snapshot was computed from; `null` = absent. */
  sourceVersion: () => Promise<number | null>;
  logger: DiagnosticsCacheLogger;
};

export type DiagnosticsCache<T> = {
  get(opts?: { force?: boolean }): Promise<T>;
};

type Snapshot<T> = {
  value: T;
  startedAt: number;
  generation: number;
  version: number | null;
};

type InFlight<T> = {
  promise: Promise<Snapshot<T>>;
  generation: number;
  version: number | null;
};

type Freshness = "fresh" | "stale" | "expired";

const SLOW_COMPUTE_MS = 1_000;

export function createDiagnosticsCache<T>(
  opts: DiagnosticsCacheOptions<T>,
): DiagnosticsCache<T> {
  const { ttlMs, staleWhileRevalidateMs, now, compute, sourceVersion } = opts;
  const logger = opts.logger;
  let snapshot: Snapshot<T> | null = null;
  let inFlight: InFlight<T> | null = null;
  let lastGeneration = 0;

  function freshness(current: Snapshot<T>): Freshness {
    const age = now() - current.startedAt;

    // A negative age means the clock went backwards: trust nothing.
    if (age < 0) return "expired";
    if (age < ttlMs) return "fresh";
    if (age < staleWhileRevalidateMs) return "stale";

    return "expired";
  }

  function store(next: Snapshot<T>): void {
    if (snapshot !== null && next.generation <= snapshot.generation) {
      logger.debug(
        { generation: next.generation, storedGeneration: snapshot.generation },
        "diagnostics snapshot discarded: an older generation finished last",
      );

      return;
    }
    snapshot = next;
  }

  function start(version: number | null): InFlight<T> {
    const generation = ++lastGeneration;
    const startedAt = now();

    logger.debug({ generation }, "diagnostics compute started");
    const promise = compute(startedAt).then((value) => {
      const durationMs = now() - startedAt;
      const next = { value, startedAt, generation, version };

      if (durationMs > SLOW_COMPUTE_MS) {
        logger.info({ generation, durationMs }, "diagnostics compute slow");
      } else {
        logger.debug({ generation, durationMs }, "diagnostics compute ended");
      }
      store(next);

      return next;
    });
    const flight = { promise, generation, version };
    const clear = (): void => {
      if (inFlight === flight) inFlight = null;
    };

    // Both arms handled: clearing never creates an unhandled rejection.
    promise.then(clear, clear);
    inFlight = flight;

    return flight;
  }

  function joinable(version: number | null, after: number): InFlight<T> | null {
    if (inFlight === null) return null;
    if (inFlight.version !== version) return null;

    return inFlight.generation > after ? inFlight : null;
  }

  async function forced(): Promise<T> {
    // Generations started after this point began after the request arrived.
    const arrivedAfter = lastGeneration;
    const version = await sourceVersion();
    const shared = joinable(version, arrivedAfter);
    const flight = shared ?? start(version);

    logger.debug(
      {
        outcome: "forced",
        joined: shared !== null,
        generation: flight.generation,
      },
      "diagnostics cache get",
    );

    return (await flight.promise).value;
  }

  async function cached(): Promise<T> {
    const version = await sourceVersion();
    const current =
      snapshot !== null && snapshot.version === version ? snapshot : null;
    const state: Freshness | "none" = current ? freshness(current) : "none";
    const ageMs = current ? now() - current.startedAt : null;

    if (current && state === "fresh") {
      logger.debug(
        { outcome: "fresh", ageMs, generation: current.generation },
        "diagnostics cache get",
      );

      return current.value;
    }

    if (current && state === "stale") {
      if (joinable(version, current.generation) === null) {
        const background = start(version);

        background.promise.catch((err: unknown) => {
          logger.warn(
            {
              generation: background.generation,
              err: err instanceof Error ? err.message : String(err),
            },
            "diagnostics background compute failed",
          );
        });
      }
      logger.debug(
        { outcome: "stale_served", ageMs, generation: current.generation },
        "diagnostics cache get",
      );

      return current.value;
    }

    const shared = joinable(version, 0);
    const flight = shared ?? start(version);
    const outcome = shared
      ? "coalesced"
      : snapshot !== null && snapshot.version !== version
        ? "source_changed"
        : "computed";

    logger.debug(
      { outcome, ageMs, generation: flight.generation },
      "diagnostics cache get",
    );

    return (await flight.promise).value;
  }

  return {
    get(getOpts) {
      return getOpts?.force ? forced() : cached();
    },
  };
}
