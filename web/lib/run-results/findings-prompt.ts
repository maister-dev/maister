import type { RunResultContract } from "./types";

import { z } from "zod";

import { isNativeFindingsContract } from "./contract";
import { evidenceFindingsV1Schema } from "./findings-types";

const APPENDIX = `Native completion contract: evidence_findings_v1.
Use the closed JSON Schema below for the final json maister:output block. All nested objects reject undeclared fields.
Evidence references contain only kind, id, optional revision, version and sha256. Copy witness.sourceVersion into reference.version when present; keep sourceId, selector, availability, timestamps and excerpts in assertion/limitations text, never as extra reference fields. Knowledge records and collected results require their exact returned revision. Do not cite an unavailable or invalid result as evidence.
sourceFindings links exact direct-child findings using {childRunId,resultRevision,findingId}; it is not a list of local finding IDs. Leaf researchers use sourceFindings:[] and selection:[]. Reducers account for every collected finding in selection. Default to verbatim retention: copy each collected finding unchanged except for a unique output id and sourceFindings:[{childRunId,resultRevision,findingId}]. Use disposition retained with exactly one outputFindingId only when assertion and basis match the source exactly. Copy all original supporting, contradicting, missingEvidence, limitations and openQuestions entries exactly, including version/digest fields; paraphrases do not preserve these entries. A paraphrased or combined assertion requires disposition combined and basis inferred, with every original evidence/limitation/question entry still copied exactly into each mapped output. Omitted needs an explicit reason and no mapped output. Use up to 32 findings, not an arbitrary smaller summary cap. Do not fetch grandchildren directly.
knowledgeProposals contains only proposal CONTENT (the content argument to knowledge_propose), never the mutation receipt, status, proposal id or idempotency key. A tool receipt and an assertion are different objects. Missing evidence permits empty citation arrays and explicit missingEvidence; never invent an identity to satisfy the schema. Retrieval and acceptance do not confirm a fact. These instructions grant no access or action authority.
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
