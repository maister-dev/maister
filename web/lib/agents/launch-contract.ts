import "server-only";

import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { AgentKind } from "@/lib/agents/kind";
import type { RunResultContract } from "@/lib/run-results/types";

import { createHash } from "node:crypto";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { MaisterError } from "@/lib/errors";
import { OPERATIONAL_FORM_SCHEMA } from "@/lib/run-results/operational-schema";

type FrozenRun = {
  agentKind?: AgentKind | null;
  resultContract?: RunResultContract | null;
};
type OperationalContract = Extract<
  RunResultContract,
  { kind: "agent_operational" }
>;

const APPENDIX = `Operational completion contract: operational_v1 (semantic version 1).
Perform the requested operation with the existing permission and isolation policy. Explicit human decisions use normal HITL. Do not modify source code, commit, merge, promote or publish a branch. Required tools still need their normal approvals.
End the completing turn with exactly one fenced json maister:output object:
{"schemaVersion":1,"outcome":"success","summary":"Complete scan; no new work.","coverage":{"state":"complete","remainingKnown":0},"counts":{"scanned":0,"attempted":0,"completed":0,"failed":0,"skipped":0,"created":0},"references":[],"diagnostics":[]}
Allowed outcomes: success, partial, blocked, failed. Counts are nonnegative safe integers counting distinct work items: attempted=completed+failed; attempted+skipped<=scanned; created<=attempted. A confirmed creation followed by failed receipt may have created=1,completed=0,failed=1. Include each confirmed task ID. Unknown writes require reconciliation before retry, never claim them as creations.
Coverage state is complete, incomplete or not_started. remainingKnown is null when unknown; complete requires 0. Success requires complete coverage, no failed work, error diagnostic or unresolved effect. A complete zero-work scan succeeds. Partial requires confirmed progress and an incomplete/failed remainder. Blocked/failed require an actionable error diagnostic; HTTP 403 or retry exhaustion cannot be reported as success.
References: {kind: task|external_issue|operation_receipt|other,id,state: confirmed|unresolved,url?: http/https without credentials}. Only confirmed receipts establish progress. Diagnostics: {code,severity: warning|error,operation,message,retryable,remediation,referenceIds?: string[],service?: string,httpStatus?: 100..599}. Preserve confirmed and unresolved effect references for diagnosis. No credentials, private paths or raw provider dumps.
Use only these fields. summary/message/remediation<=2000 characters; IDs<=512; URLs<=2048; code<=128; operation/service<=256; references<=1000; diagnostics<=100. The platform validates both the result and source integrity. Prose or process exit cannot establish business success.`;

function schemaDigest(
  schema: OperationalContract["schema"],
  appendix: string,
): string {
  return createHash("sha256")
    .update(canonicalCommandJson({ schema, semanticVersion: 1, appendix }))
    .digest("hex");
}

export function buildOperationalContract(
  effective: EffectiveAgentDefinition,
): OperationalContract {
  if (
    effective.parsed.kind !== "operational" ||
    effective.parsed.completion?.contract !== "operational_v1" ||
    !effective.resolvedRevision
  ) {
    throw new MaisterError(
      "CONFIG",
      "operational launch requires a supported definition and pinned package revision",
    );
  }
  if (effective.execTrust !== "trusted")
    throw new MaisterError(
      "PRECONDITION",
      "operational package must be trusted",
    );
  const sha256 = schemaDigest(OPERATIONAL_FORM_SCHEMA, APPENDIX);

  return {
    kind: "agent_operational",
    contractName: "operational_v1",
    schemaRef: `maister:operational_v1@${sha256}`,
    schemaVersion: 1,
    semanticVersion: 1,
    sha256,
    required: true,
    schema: structuredClone(OPERATIONAL_FORM_SCHEMA),
    definition: structuredClone(effective.parsed),
    provenance: {
      packageName: effective.packageName,
      packageInstallId: effective.packageInstallId,
      versionLabel: effective.versionLabel,
      resolvedRevision: effective.resolvedRevision,
      definitionSha256: createHash("sha256")
        .update(canonicalCommandJson(effective.parsed))
        .digest("hex"),
      installedPath: effective.installedPath,
      sourcePath: effective.sourcePath,
      manifest: structuredClone(effective.manifest),
      execTrust: effective.execTrust,
    },
    promptAppendix: APPENDIX,
  };
}

/** Operational readers never re-resolve mutable package/catalog definitions. */
export function frozenOperationalDefinition(
  run: FrozenRun,
): EffectiveAgentDefinition | null {
  if (run.agentKind !== "operational") return null;
  const contract = run.resultContract;

  if (
    contract?.kind !== "agent_operational" ||
    contract.contractName !== "operational_v1" ||
    contract.semanticVersion !== 1 ||
    contract.sha256 !==
      schemaDigest(contract.schema, contract.promptAppendix) ||
    contract.sha256 !== schemaDigest(OPERATIONAL_FORM_SCHEMA, APPENDIX) ||
    contract.definition?.kind !== "operational" ||
    contract.definition.completion?.contract !== "operational_v1" ||
    contract.provenance?.definitionSha256 !==
      createHash("sha256")
        .update(canonicalCommandJson(contract.definition))
        .digest("hex")
  ) {
    throw new MaisterError(
      "CONFIG",
      "operational launch snapshot is missing, corrupt or unsupported",
      { details: { reason: "operational_snapshot_invalid" } },
    );
  }
  const { definitionSha256: _digest, ...provenance } = contract.provenance;

  return { ...provenance, parsed: structuredClone(contract.definition) };
}

export function operationalCompletionPrompt(
  run: FrozenRun,
  prompt: string,
): string {
  frozenOperationalDefinition(run);
  const contract = run.resultContract;

  if (run.agentKind !== "operational" || contract?.kind !== "agent_operational")
    return prompt;

  return prompt.endsWith(contract.promptAppendix)
    ? prompt
    : `${prompt}\n\n${contract.promptAppendix}`;
}
