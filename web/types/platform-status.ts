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
};

export type PlatformUnavailableReason =
  | "network"
  | "timeout"
  | "http"
  | "malformed";

export type PlatformStatus =
  | {
      kind: "ready";
      health: SupervisorHealth;
    }
  | {
      kind: "unavailable";
      reason: PlatformUnavailableReason;
      message: string;
    };
