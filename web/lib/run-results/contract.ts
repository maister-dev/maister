import type { FormSchema } from "@/lib/config.schema";
import type { RunResultContract } from "@/lib/run-results/types";

// ADR-165 (D2): the launch-time contract snapshot and the schema reference that
// identifies it. Pure — no db, no `server-only` — so the launcher, the seam and
// the read models all build the SAME string from the SAME inputs.

/** How much of `resolved_revision` `schemaRef` carries. */
export const SCHEMA_REF_REVISION_LEN = 12;

/**
 * `<flowRefId>@<resolvedRevision[:12]>:<schemaStem>`.
 *
 * Every component is server state: the flow ref and the pinned revision come
 * from `flow_revisions`, the stem from the declared package-root path. No part
 * of it is ever body-controlled.
 */
export function schemaRefFor(args: {
  flowRefId: string;
  resolvedRevision: string;
  schemaStem: string;
}): string {
  const revision = args.resolvedRevision.slice(0, SCHEMA_REF_REVISION_LEN);

  return `${args.flowRefId}@${revision}:${args.schemaStem}`;
}

/** `./schemas/research-result.v1.json` -> `research-result.v1`. */
export function schemaStemFromPath(schemaPath: string): string {
  const file = schemaPath.trim().replace(/^\.\//, "").split("/").pop() ?? "";

  return file.replace(/\.json$/, "");
}

/**
 * The contract a FLOW run is held to, built by the launcher from the PINNED
 * revision's `result.export` before the worktree exists.
 */
export function buildFlowExportContract(args: {
  flowRefId: string;
  resolvedRevision: string;
  flowRevisionId: string;
  schemaPath: string;
  schema: FormSchema;
  sha256: string;
  required: boolean;
  producerNodeIds: readonly string[];
}): RunResultContract {
  return {
    kind: "flow_export",
    schemaRef: schemaRefFor({
      flowRefId: args.flowRefId,
      resolvedRevision: args.resolvedRevision,
      schemaStem: schemaStemFromPath(args.schemaPath),
    }),
    schemaVersion: args.schema.schemaVersion,
    sha256: args.sha256,
    required: args.required,
    producerNodeIds: [...args.producerNodeIds],
    schema: args.schema,
    flowRevisionId: args.flowRevisionId,
  };
}

/**
 * The contract a delegated AGENT child is held to, built from the PARENT run's
 * pinned `flow_revisions.result_profiles` entry. `sourceFlowRevisionId` records
 * WHICH pinned revision the name resolved against, so a profile later removed
 * upstream is still explainable from the run row alone.
 */
export function buildAgentProfileContract(args: {
  profileName: string;
  flowRefId: string;
  resolvedRevision: string;
  sourceFlowRevisionId: string;
  schemaStem: string;
  schemaVersion: number;
  schema: FormSchema;
  sha256: string;
}): RunResultContract {
  return {
    kind: "agent_profile",
    profileName: args.profileName,
    schemaRef: schemaRefFor({
      flowRefId: args.flowRefId,
      resolvedRevision: args.resolvedRevision,
      schemaStem: args.schemaStem,
    }),
    schemaVersion: args.schemaVersion,
    sha256: args.sha256,
    required: true,
    schema: args.schema,
    sourceFlowRevisionId: args.sourceFlowRevisionId,
  };
}

/** True when `nodeId` is one of the contract's permitted producers. */
export function isResultProducerNode(
  contract: RunResultContract | null,
  nodeId: string,
): boolean {
  return (
    contract?.kind === "flow_export" &&
    contract.producerNodeIds.includes(nodeId)
  );
}
