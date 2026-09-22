export type SupervisorEventStreamHealth = {
  streamId: string;
  headSequence: string | null;
  unacknowledgedCount: number;
  retainedCount: number;
  pressured: boolean;
  oldestUnacknowledgedAgeMs: number | null;
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
