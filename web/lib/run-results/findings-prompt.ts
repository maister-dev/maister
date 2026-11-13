import type { RunResultContract } from "./types";
import type { EvidenceFindingsV1 } from "./findings-types";

import { z } from "zod";

import {
  isNativeFindingsContract,
  isOperationalEvidenceContract,
} from "./contract";
import { evidenceFindingsV1Schema } from "./findings-types";
import { operationalEvidenceV2Schema } from "./operational-schema";

const LEAF_RESULT_EXAMPLE = {
  schemaVersion: 1,
  findings: [
    {
      id: "missing-observation",
      assertion:
        "The requested state cannot be established from the available evidence.",
      basis: "inferred",
      supporting: [],
      contradicting: [],
      missingEvidence: [
        { state: "absent", reason: "No authorized observation is available." },
      ],
      limitations: ["Freshness and applicability are unknown."],
      openQuestions: [],
      sourceFindings: [],
    },
  ],
  knowledgeProposals: [],
  selection: [],
} satisfies EvidenceFindingsV1;

const APPENDIX = `Native completion contract: evidence_findings_v1.
Use the closed JSON Schema below for the final json maister:output block. All nested objects reject undeclared fields.
Write the complete opening fence exactly as shown in the example, with json maister:output together on the same line and no indentation. The next line starts the JSON object; close with three backticks on a separate line. Keep the marker out of the JSON body. End the turn with this block.
Evidence references contain only kind, id, optional revision, version and sha256. Prefer minimal references: {kind:"knowledge",id,revision}, {kind:"witness",id}, or {kind:"result",id,revision}. An immutable witness ID already binds its captured source version and digest; retrieve its evidence view for those details. Optional version/sha256 are needed only when explicitly requested, and must match exactly if supplied; do not retype long digests unnecessarily. Reducers preserve any version/digest fields already present in their collected child references. Keep sourceId, selector, availability, timestamps and excerpts in assertion/limitations text, never as extra reference fields. Knowledge records and collected results require their exact returned revision. Do not cite an unavailable or invalid result as evidence.
sourceFindings links exact direct-child findings using {childRunId,resultRevision,findingId}; it is not a list of local finding IDs. For each finding in a direct child's collected result.value.findings, findingId is that finding object's own id; childRunId is that direct child's run ID and resultRevision is its collected resultRevision. Never copy childRunId or findingId from the child's sourceFindings or selection: those identify an earlier depth. Rework reuses existing child/result identities rather than redelegating completed work. Leaf researchers leave every finding.sourceFindings empty and set the result-root selection array to []. Reducers account for every collected finding in selection. Default to verbatim retention: copy each collected finding unchanged except for a unique output id and sourceFindings:[{childRunId,resultRevision,findingId}]. Use disposition retained with exactly one outputFindingId only when assertion and basis match the source exactly. Copy all original supporting, contradicting, missingEvidence, limitations and openQuestions entries exactly, including version/digest fields; paraphrases do not preserve these entries. A paraphrased or combined assertion requires disposition combined and basis inferred, with every original evidence/limitation/question entry still copied exactly into each mapped output. Omitted needs an explicit reason and no mapped output. Use up to 32 findings, not an arbitrary smaller summary cap. Do not fetch grandchildren directly.
Before emitting the result, check each finding.sourceFindings link against selection: the matching entry must name that finding's id in outputFindingIds. A retained entry names only its one verbatim output. If you retain the child findings, keep a synthesis of those findings in the proposal content when requested. Do not add a second finding that links to their retained sources. To publish a synthesized finding with those links, use combined entries that explicitly map the sources to that inferred finding.
knowledgeProposals contains only proposal CONTENT (the content argument to knowledge_propose), never the mutation receipt, status, proposal id or idempotency key. A tool receipt and an assertion are different objects. Missing evidence permits empty citation arrays and explicit missingEvidence; never invent an identity to satisfy the schema. Retrieval and acceptance do not confirm a fact. These instructions grant no access or action authority.
selection belongs only to the result root, alongside findings and knowledgeProposals. Never put selection inside a finding. A leaf researcher sets each finding.sourceFindings to [] and the result-root selection to []. A reducer adds its accounting entries to result-root selection, separately from the finding objects.
The following example demonstrates shape and explicit missing evidence only. Replace its local finding ID and text with your actual findings; it supplies no source identities or facts.
Native leaf result example (shape only):
${["```json maister:output", JSON.stringify(LEAF_RESULT_EXAMPLE), "```"].join("\n")}
Native result JSON Schema:
${JSON.stringify(z.toJSONSchema(evidenceFindingsV1Schema, { target: "draft-07", io: "input" }))}`;

const operationalExample: z.input<typeof operationalEvidenceV2Schema> = {
  schemaVersion: 2,
  outcome: "success",
  summary: "Bounded read-only work finished.",
  coverage: { state: "complete", remainingKnown: 0 },
  counts: {
    scanned: 1,
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    created: 0,
  },
  references: [],
  diagnostics: [],
  findings: LEAF_RESULT_EXAMPLE,
  operationIds: [],
  verificationIds: [],
};
const OPERATIONAL_APPENDIX = `Native completion contract: operational_evidence_v2.
For the completing turn, use the exact json maister:output fence and object shape below. This example illustrates shape only. Replace its text and local finding ID with your actual result. All objects reject extra fields.
Put knowledge, witness and result references inside the nested findings. A knowledge or result citation requires its exact revision; an immutable witness ID is sufficient when its version or digest was not requested. Keep report limitations and missing evidence explicit. A direct child's finding is identified by its exact childRunId, resultRevision and findingId. Preserve original evidence when filling findings.selection; a leaf leaves selection and each sourceFindings array empty.
Use top-level operationIds and verificationIds only for exact retained stand identities. Keep top-level references empty when there are only Brain or stand references. Successful outcomes require complete coverage, remainingKnown 0, no failed work and no error diagnostic. A blocked outcome includes an actionable error diagnostic. The example does not supply evidence or authorize any action.
Native operational result example (shape only):
${["```json maister:output", JSON.stringify(operationalExample), "```"].join("\n")}
Native operational result JSON Schema:
${JSON.stringify(z.toJSONSchema(operationalEvidenceV2Schema, { target: "draft-07", io: "input" }))}`;

/** Supply the versioned nested grammar even when a package's FormSchema uses opaque JSON fields. */
export function nativeFindingsCompletionPrompt(
  contract: RunResultContract | null | undefined,
  prompt: string,
): string {
  const appendix = isNativeFindingsContract(contract)
    ? APPENDIX
    : isOperationalEvidenceContract(contract)
      ? OPERATIONAL_APPENDIX
      : null;

  return !appendix || prompt.includes(`\n\n${appendix}`)
    ? prompt
    : `${prompt}\n\n${appendix}`;
}
