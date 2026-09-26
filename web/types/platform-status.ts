// ADR-167 amendment 2026-09-25: why the host closed `GET /runtime-events`
// connections. Mirrors the supervisor's close-reason union.
export const RUNTIME_EVENT_CLOSE_REASONS = [
  "disconnect",
  "protocol",
  "floor",
  "shutdown",
] as const;

export type RuntimeEventCloseReason =
  (typeof RUNTIME_EVENT_CLOSE_REASONS)[number];

export type RuntimeEventStreamCloses = Record<RuntimeEventCloseReason, number>;

/** ADR-183: the host's outbox-pressure episode (the manager is behind). */
export type SupervisorEventStreamPressure = {
  since: string;
  unacknowledgedCountAtStart: number;
  unacknowledgedBytesAtStart: number;
  episodes: number;
};

export type SupervisorEventStreamHealth = {
  streamId: string;
  headSequence: string | null;
  unacknowledgedCount: number;
  retainedCount: number;
  /** Unacknowledged rows at the soft budget — never retained rows (ADR-183). */
  pressured: boolean;
  oldestUnacknowledgedAgeMs: number | null;
  /** Subscriber telemetry since the host's boot; absent from an older host. */
  subscriberPauses?: number;
  closes?: RuntimeEventStreamCloses;
  /** Null while not pressured; absent from an older host (ADR-183). */
  pressure?: SupervisorEventStreamPressure | null;
};

export type SupervisorHealth = {
  status: "ready";
  // ADR-166: the durable execution-host identity (absent on a pre-ADR-166
  // supervisor, which the registrar then refuses to register).
  host?: { hostKey: string; bootId: string; protocolVersion: 1 };
  version: string;
  uptimeMs: number;
  checkedAt: string;
  sessions: {
    live: number;
    exited: number;
    crashed: number;
  };
  stream?: SupervisorEventStreamHealth;
};

export type PlatformUnavailableReason =
  | "network"
  | "timeout"
  | "http"
  | "malformed";

export type PlatformLagSummary = Readonly<{
  scope: "host_backlog";
  status: "clear" | "behind" | "unknown";
  sampledAt: string;
}>;

export type PlatformStatus =
  | {
      kind: "ready";
      health: SupervisorHealth;
      lag?: PlatformLagSummary;
    }
  | {
      kind: "unavailable";
      reason: PlatformUnavailableReason;
      message: string;
    };
