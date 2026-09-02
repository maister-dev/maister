import type { FormSchema } from "@/lib/config.schema";

// ADR-165 Appendix A — the normative shapes of the public result plane. This
// module is TYPES ONLY and imports nothing that touches a database, a launcher
// or `server-only`, so `lib/db/schema.ts` can apply them as Drizzle `$type<>()`
// without pulling the runtime in.

export type RunResultValidity = "valid" | "stale" | "superseded" | "invalid";

export type RunResultProducerKind = "flow_node" | "agent_session";

/**
 * Why a publish attempt produced no usable value. Application-level, NOT a DB
 * CHECK, so the ADR-162 limit classes can grow without a migration. Surfaced to
 * a coordinator as `run_collect`'s `resultFailure.reason`.
 */
export type RunResultInvalidReason =
  | "result_missing"
  | "malformed_json"
  | "oversize"
  | "unsafe_key"
  | "depth_limit"
  | "key_limit"
  | "array_limit"
  | "schema_mismatch";

/** One entry of the engine artifact manifest captured AT PUBLISH (audit). */
export type RunResultArtifactRef = {
  artifactId: string;
  kind: string;
  nodeId: string | null;
  validity: string;
};

/**
 * The run-level result contract, snapshotted on `runs.result_contract` by the
 * launcher in the run-insert transaction. Terminal and collection paths read
 * only this — never the pinned revision again, and never a live catalog row.
 */
export type RunResultContract =
  | {
      kind: "flow_export";
      schemaRef: string;
      schemaVersion: number;
      sha256: string;
      required: boolean;
      producerNodeIds: string[];
      schema: FormSchema;
      flowRevisionId: string;
    }
  | {
      kind: "agent_profile";
      profileName: string;
      schemaRef: string;
      schemaVersion: number;
      sha256: string;
      // A delegated agent child selects a profile explicitly; there is no
      // "optional profile" wire form, so the contract is always required.
      required: true;
      schema: FormSchema;
      sourceFlowRevisionId: string;
    };

export type DelegationBudget = {
  maxTokens: number;
  wallClockMinutes: number;
  maxChildRuns: number;
  consecutiveFailures: number;
};

/** The raw `settings.delegation` block, kept verbatim for audit. */
export type DeclaredDelegationBounds = {
  max_depth?: number;
  max_fanout?: number;
  max_active_children?: number;
  budget?: DelegationBudget;
};

/** The instance ceilings the effective bounds were min-merged against. */
export type DelegationInstanceCeilings = {
  maxDepth: number;
  maxFanout: number;
  flowPool: number;
  agentPool: number;
};

/**
 * The EFFECTIVE bounds an orchestrator node computed at its start, snapshotted
 * on `runs.delegation_bounds`. `source: "env"` means the manifest is below the
 * 3.7.0 floor and the node declaration was ignored entirely.
 */
export type DelegationBounds = {
  nodeId: string;
  nodeAttemptId: string;
  engineMin: string | null;
  source: "env" | "node";
  maxDepth: number;
  maxFanout: number;
  maxActiveChildren: number | null;
  budget: DelegationBudget | null;
  declared: DeclaredDelegationBounds | null;
  instance: DelegationInstanceCeilings;
};

/** `flow_revisions.result_profiles` — a package's named agent contracts. */
export type ResultProfileMap = Record<
  string,
  {
    schemaPath: string;
    schemaStem: string;
    schemaVersion: number;
    sha256: string;
    schema: FormSchema;
  }
>;

/** The wire envelope. The producer supplies ONLY `value`. */
export type PublicRunResult = { schemaRef: string; value: unknown };

export type ResultStatus =
  | "pending"
  | "valid"
  | "absent"
  | "missing"
  | "stale"
  | "invalid"
  | "unavailable";

/** A persisted `run_results` row, as the ledger and the read models see it. */
export type RunResultRow = {
  id: string;
  runId: string;
  revision: number;
  validity: RunResultValidity;
  schemaRef: string;
  schemaSha256: string;
  schemaVersion: number;
  producerKind: RunResultProducerKind;
  /** A flow node id, or `session:default` for an agent session. */
  producerRef: string;
  nodeAttemptId: string | null;
  value: unknown | null;
  valueBytes: number;
  invalidReason: RunResultInvalidReason | null;
  artifactManifest: RunResultArtifactRef[];
  engineVersion: string;
  supersededById: string | null;
  supersededAt: Date | null;
  firstCollectedAt: Date | null;
  createdAt: Date;
};
