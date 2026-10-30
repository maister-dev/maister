export type AgentActivitySnapshot = {
  version: 1;
  agentId: string;
  displayName: string;
  definitionSha256: string;
  packageInstallId: string;
  packageName: string;
  packageVersion: string;
  packageRevision: string | null;
  retryOrigin?: {
    sourceRunId: string;
    intentId: string;
    originalEventId: number | null;
  };
  comparisonScopes?: { business: string; infrastructure: string };
};

export type AgentActivityTimestampProvenance =
  "launch" | "verified_creation" | "legacy_estimate" | "migration_estimate";

export type AgentIncidentScopeKind = "business" | "infrastructure" | "unknown";
export type AgentIncidentChannel =
  | "operational_terminal"
  | "execution_failure"
  | "admission_refusal"
  | "cleanup";
