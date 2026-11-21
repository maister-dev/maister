import "server-only";

import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { AgentKind } from "@/lib/agents/kind";
import type { RunResultContract } from "@/lib/run-results/types";

import { createHash } from "node:crypto";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { MaisterError } from "@/lib/errors";
import { OPERATIONAL_EVIDENCE_CONTRACT } from "@/lib/agents/kind";
import {
  OPERATIONAL_EVIDENCE_FORM_SCHEMA,
  OPERATIONAL_FORM_SCHEMA,
} from "@/lib/run-results/operational-schema";

type FrozenRun = {
  agentKind?: AgentKind | null;
  resultContract?: RunResultContract | null;
};
type OperationalContract = Extract<
  RunResultContract,
  { kind: "agent_operational" }
>;

const APPENDIX = `Operational completion contract: operational_v1 (semantic version 1).
Perform the requested operation with the existing permission and isolation policy. Explicit human decisions use normal HITL. After resume, read the task's confirmed human clarifications before continuing pending work. Do not modify source code, commit, merge, promote or publish a branch. Required tools still need their normal approvals.
End the completing turn with exactly one fenced json maister:output object:
{"schemaVersion":1,"outcome":"success","summary":"Complete scan; no new work.","coverage":{"state":"complete","remainingKnown":0},"counts":{"scanned":0,"attempted":0,"completed":0,"failed":0,"skipped":0,"created":0},"references":[],"diagnostics":[]}
Allowed outcomes: success, partial, blocked, failed. Counts are nonnegative safe integers counting distinct work items: attempted=completed+failed; attempted+skipped<=scanned; created<=attempted. A confirmed creation followed by failed receipt may have created=1,completed=0,failed=1. Include each confirmed task ID. Unknown writes require reconciliation before retry, never claim them as creations.
Coverage state is complete, incomplete or not_started. remainingKnown is null when unknown; complete requires 0. For not_started, all work-item counts must be zero. A failed setup or tool call before scanning the first work item belongs in diagnostics, with known pending work reflected in remainingKnown. Complete coverage means the scan finished, not that its business operations succeeded. Success requires complete coverage, no failed work, error diagnostic or unresolved effect. A complete zero-work scan succeeds. Partial requires confirmed progress and an incomplete/failed remainder. Confirmed progress means completed>0 OR created>0 OR a confirmed operation_receipt. Count only work performed during this run. Verifying previously imported tasks or skipping existing tasks alone is not progress. A confirmed operation_receipt qualifies only for actual new work performed during this run; never relabel old verified or skipped receipts to manufacture progress. When all pending imports are held for reconciliation and no confirmed progress exists, report blocked with an actionable error diagnostic. Execution failure with no confirmed progress is failed. HTTP 403 or retry exhaustion cannot be reported as success.
Example with no confirmed progress and four imports held for reconciliation:
{"schemaVersion":1,"outcome":"blocked","summary":"Imports require reconciliation.","coverage":{"state":"complete","remainingKnown":0},"counts":{"scanned":18,"attempted":4,"completed":0,"failed":4,"skipped":14,"created":0},"references":[{"kind":"external_issue","id":"github:owner/repo#1","state":"unresolved"},{"kind":"external_issue","id":"github:owner/repo#2","state":"unresolved"},{"kind":"external_issue","id":"github:owner/repo#3","state":"unresolved"},{"kind":"external_issue","id":"github:owner/repo#4","state":"unresolved"}],"diagnostics":[{"code":"IMPORT_RECONCILIATION_REQUIRED","severity":"error","operation":"github_issue_import","message":"Four imports are held pending reconciliation.","retryable":false,"remediation":"Reconcile the four referenced imports before retrying.","referenceIds":["github:owner/repo#1","github:owner/repo#2","github:owner/repo#3","github:owner/repo#4"]}]}
References: {kind: task|external_issue|operation_receipt|other,id,state: confirmed|unresolved,url?: http/https without credentials}. A confirmed reference establishes progress only when kind=operation_receipt; confirmed task/external_issue/other references alone do not. Diagnostics: {code,severity: warning|error,operation,message,retryable,remediation,referenceIds?: string[],service?: string,httpStatus?: 100..599}. Blocked/failed require an actionable error diagnostic. Preserve confirmed and unresolved effect references for diagnosis. No credentials, private paths or raw provider dumps.
Use only these fields. summary/message/remediation<=2000 characters; IDs<=512; URLs<=2048; code<=128; operation/service<=256; references<=1000; diagnostics<=100. The platform validates both the result and source integrity. Prose or process exit cannot establish business success.`;

// Preserve exact supported snapshots across instruction-only revisions of v1.
const SUPPORTED_V1_DIGESTS: readonly string[] = [
  "8c83781c8f59b78bd73d55484f82bfb1d2c905635dda645b3c09ff97e7e82cc6",
  "29aabe79a069790492a8e2cb89b1cec5f6ec4afa0573fb155b21506dc29c7319",
];

const EVIDENCE_APPENDIX = `Operational completion contract: operational_evidence_v2 (semantic version 2).
Use the existing permission, isolation and human clarification policy. End the completing turn with exactly one fenced json maister:output object:
{"schemaVersion":2,"outcome":"success","summary":"Read-only observation finished.","coverage":{"state":"complete","remainingKnown":0},"counts":{"scanned":0,"attempted":0,"completed":0,"failed":0,"skipped":0,"created":0},"references":[],"diagnostics":[],"findings":{"schemaVersion":1,"findings":[],"knowledgeProposals":[],"selection":[]},"operationIds":[],"verificationIds":[]}
Keep findings in evidence_findings_v1, including limitations, open questions and exact original child references. Use empty evidence arrays when evidence is missing. Do not invent IDs, sources or confirmation.
Use operationIds only for exact operations recorded by the platform and verificationIds only for independently recorded verification. Report uncertainty and unmet obligations explicitly. The platform validates the witnesses. Do not put operation receipts or confirmations into references. No credentials, private paths or raw logs.
Outcome is success, partial, blocked or failed. Success requires complete coverage and no failed work, errors or unresolved effects. Blocked and failed require an actionable error diagnostic. Report distinct work counts with attempted=completed+failed, attempted+skipped<=scanned and created<=attempted.`;

function schemaDigest(
  schema: OperationalContract["schema"],
  appendix: string,
  semanticVersion: OperationalContract["semanticVersion"],
): string {
  return createHash("sha256")
    .update(canonicalCommandJson({ schema, semanticVersion, appendix }))
    .digest("hex");
}

function evidenceDigest(): string {
  return schemaDigest(OPERATIONAL_EVIDENCE_FORM_SCHEMA, EVIDENCE_APPENDIX, 2);
}

export function buildOperationalContract(
  effective: EffectiveAgentDefinition,
): OperationalContract {
  const name = effective.parsed.completion?.contract;

  if (
    effective.parsed.kind !== "operational" ||
    (name !== "operational_v1" && name !== OPERATIONAL_EVIDENCE_CONTRACT) ||
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
  const frozen = {
    kind: "agent_operational",
    required: true,
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
  } as const;

  if (name === OPERATIONAL_EVIDENCE_CONTRACT) {
    const sha256 = evidenceDigest();

    return {
      ...frozen,
      contractName: name,
      schemaRef: `maister:${name}@${sha256}`,
      schemaVersion: 2,
      semanticVersion: 2,
      sha256,
      schema: structuredClone(OPERATIONAL_EVIDENCE_FORM_SCHEMA),
      promptAppendix: EVIDENCE_APPENDIX,
    };
  }
  const sha256 = schemaDigest(OPERATIONAL_FORM_SCHEMA, APPENDIX, 1);

  return {
    ...frozen,
    contractName: name,
    schemaRef: `maister:${name}@${sha256}`,
    schemaVersion: 1,
    semanticVersion: 1,
    sha256,
    schema: structuredClone(OPERATIONAL_FORM_SCHEMA),
    promptAppendix: APPENDIX,
  };
}

function hasSupportedOperationalDigest(contract: OperationalContract): boolean {
  if (contract.contractName === OPERATIONAL_EVIDENCE_CONTRACT)
    return (
      contract.schemaVersion === 2 &&
      contract.semanticVersion === 2 &&
      contract.sha256 === evidenceDigest() &&
      contract.sha256 ===
        schemaDigest(contract.schema, contract.promptAppendix, 2)
    );

  return (
    contract.contractName === "operational_v1" &&
    contract.semanticVersion === 1 &&
    (SUPPORTED_V1_DIGESTS.includes(contract.sha256) ||
      contract.sha256 === schemaDigest(OPERATIONAL_FORM_SCHEMA, APPENDIX, 1)) &&
    contract.sha256 ===
      schemaDigest(contract.schema, contract.promptAppendix, 1) &&
    contract.sha256 ===
      schemaDigest(OPERATIONAL_FORM_SCHEMA, contract.promptAppendix, 1)
  );
}

/** Operational readers never re-resolve mutable package/catalog definitions. */
export function frozenOperationalDefinition(
  run: FrozenRun,
): EffectiveAgentDefinition | null {
  if (run.agentKind !== "operational") return null;
  const contract = run.resultContract;

  if (
    contract?.kind !== "agent_operational" ||
    !hasSupportedOperationalDigest(contract) ||
    contract.definition?.kind !== "operational" ||
    contract.definition.completion?.contract !== contract.contractName ||
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

/** A confirmed business response is new input; completion instructions stay frozen. */
export function operationalHumanAnswerPrompt(
  run: FrozenRun,
  original: string,
  response: unknown,
): string {
  frozenOperationalDefinition(run);
  const contract = run.resultContract;

  if (
    contract?.kind !== "agent_operational" ||
    !response ||
    typeof response !== "object"
  )
    throw new MaisterError(
      "CONFIG",
      "operational human continuation requires its frozen contract and confirmed response",
    );
  const answer = Object.fromEntries(
    Object.entries(response).filter(
      ([key]) => key !== "_agentResume" && key !== "_audit",
    ),
  );
  const base = original.endsWith(contract.promptAppendix)
    ? original.slice(0, -contract.promptAppendix.length).trimEnd()
    : original;

  return operationalCompletionPrompt(
    run,
    `${base}\n\nConfirmed human response:\n\`\`\`json\n${canonicalCommandJson(answer)}\n\`\`\``,
  );
}
