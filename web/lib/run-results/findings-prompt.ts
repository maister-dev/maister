import type { RunResultContract } from "./types";
import type { EvidenceFindingsV1 } from "./findings-types";

import { z } from "zod";

import { isNativeFindingsContract } from "./contract";
import { evidenceFindingsV1Schema } from "./findings-types";

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
Evidence references contain only kind, id, optional revision, version and sha256. Prefer minimal references: {kind:"knowledge",id,revision}, {kind:"witness",id}, or {kind:"result",id,revision}. An immutable witness ID already binds its captured source version and digest; retrieve its evidence view for those details. Optional version/sha256 are needed only when explicitly requested, and must match exactly if supplied; do not retype long digests unnecessarily. Reducers preserve any version/digest fields already present in their collected child references. Keep sourceId, selector, availability, timestamps and excerpts in assertion/limitations text, never as extra reference fields. Knowledge records and collected results require their exact returned revision. Do not cite an unavailable or invalid result as evidence.
sourceFindings links exact direct-child findings using {childRunId,resultRevision,findingId}; it is not a list of local finding IDs. For each finding in a direct child's collected result.value.findings, findingId is that finding object's own id; childRunId is that direct child's run ID and resultRevision is its collected resultRevision. Never copy childRunId or findingId from the child's sourceFindings or selection: those identify an earlier depth. Rework reuses existing child/result identities rather than redelegating completed work. Leaf researchers leave every finding.sourceFindings empty and set the result-root selection array to []. Reducers account for every collected finding in selection. Default to verbatim retention: copy each collected finding unchanged except for a unique output id and sourceFindings:[{childRunId,resultRevision,findingId}]. Use disposition retained with exactly one outputFindingId only when assertion and basis match the source exactly. Copy all original supporting, contradicting, missingEvidence, limitations and openQuestions entries exactly, including version/digest fields; paraphrases do not preserve these entries. A paraphrased or combined assertion requires disposition combined and basis inferred, with every original evidence/limitation/question entry still copied exactly into each mapped output. Omitted needs an explicit reason and no mapped output. Use up to 32 findings, not an arbitrary smaller summary cap. Do not fetch grandchildren directly.
knowledgeProposals contains only proposal CONTENT (the content argument to knowledge_propose), never the mutation receipt, status, proposal id or idempotency key. A tool receipt and an assertion are different objects. Missing evidence permits empty citation arrays and explicit missingEvidence; never invent an identity to satisfy the schema. Retrieval and acceptance do not confirm a fact. These instructions grant no access or action authority.
selection belongs only to the result root, alongside findings and knowledgeProposals. Never put selection inside a finding. A leaf researcher sets each finding.sourceFindings to [] and the result-root selection to []. A reducer adds its accounting entries to result-root selection, separately from the finding objects.
The following example demonstrates shape and explicit missing evidence only. Replace its local finding ID and text with your actual findings; it supplies no source identities or facts.
Native leaf result example (shape only):
${JSON.stringify(LEAF_RESULT_EXAMPLE)}
Native result JSON Schema:
${JSON.stringify(z.toJSONSchema(evidenceFindingsV1Schema, { target: "draft-07", io: "input" }))}`;

/** Supply the versioned nested grammar even when a package's FormSchema uses opaque JSON fields. */
export function nativeFindingsCompletionPrompt(
  contract: RunResultContract | null | undefined,
  prompt: string,
): string {
  if (!isNativeFindingsContract(contract)) return prompt;

  return prompt.endsWith(APPENDIX) ? prompt : `${prompt}\n\n${APPENDIX}`;
}
