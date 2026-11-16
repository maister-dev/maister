import "server-only";

import type { KnowledgeTransaction } from "@/lib/brain/knowledge-access";
import type { KnowledgeReference } from "@/lib/brain/knowledge-types";
import type { KnowledgeAccessRestriction } from "@/lib/company/types";
import type {
  EvidenceFinding,
  EvidenceFindingsV1,
  SourceFinding,
} from "./findings-types";

import { sql } from "drizzle-orm";

import { FINDINGS_CONTRACT } from "./findings-contract";
import { evidenceFindingsV1Schema } from "./findings-types";

import { OPERATIONAL_EVIDENCE_CONTRACT } from "@/lib/agents/kind";
import { knowledgeAccessCaptureSchema } from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

const MAX_SOURCE_FINDINGS = 256;
const MAX_REDUCTION_INPUT_BYTES = 4 * 1024 * 1024;

export type InheritedResultReference = Readonly<{
  reference: KnowledgeReference;
  childRunId: string;
}>;
export type FindingsReduction = Readonly<{
  hasSources: boolean;
  restrictions: readonly KnowledgeAccessRestriction[];
  inheritedResultReferences: readonly InheritedResultReference[];
}>;
type Source = Readonly<{
  finding: EvidenceFinding;
  childRunId: string;
  validity: string;
}>;
type SourceRow = Readonly<{
  child_run_id: string;
  revision: number;
  validity: string;
  value: unknown;
  knowledge_access: unknown;
}>;

function requireReduction(condition: boolean, path: string): asserts condition {
  if (!condition)
    throw new MaisterError(
      "PRECONDITION",
      "Native reduction must account for exact collected findings and preserve their evidence and limitations",
      { details: { reason: "findings_reduction_invalid", path } },
    );
}

function findingKey(source: SourceFinding): string {
  return JSON.stringify([
    source.childRunId,
    source.resultRevision,
    source.findingId,
  ]);
}

/** Additional known witnesses are allowed; original identity and known version/digest fields cannot disappear. */
export function retainsEvidenceReference(
  candidate: KnowledgeReference,
  original: KnowledgeReference,
): boolean {
  return (
    candidate.kind === original.kind &&
    candidate.id === original.id &&
    (original.revision === undefined ||
      candidate.revision === original.revision) &&
    (original.version === undefined ||
      candidate.version === original.version) &&
    (original.sha256 === undefined || candidate.sha256 === original.sha256)
  );
}

function preservesSource(
  output: EvidenceFinding,
  source: EvidenceFinding,
): boolean {
  const missing = new Set(output.missingEvidence.map(contentDigest));

  return (
    source.supporting.every((original) =>
      output.supporting.some((candidate) =>
        retainsEvidenceReference(candidate, original),
      ),
    ) &&
    source.contradicting.every((original) =>
      output.contradicting.some((candidate) =>
        retainsEvidenceReference(candidate, original),
      ),
    ) &&
    source.missingEvidence.every((entry) =>
      missing.has(contentDigest(entry)),
    ) &&
    source.limitations.every((entry) => output.limitations.includes(entry)) &&
    source.openQuestions.every((entry) => output.openQuestions.includes(entry))
  );
}

function validateSelection(
  value: EvidenceFindingsV1,
  sources: ReadonlyMap<string, Source>,
): readonly InheritedResultReference[] {
  const selection = new Map(
    value.selection.map((entry) => [findingKey(entry), entry]),
  );

  requireReduction(
    selection.size === value.selection.length &&
      selection.size === sources.size,
    "selection",
  );
  const outputs = new Map(
    value.findings.map((finding) => [finding.id, finding]),
  );
  const inherited: InheritedResultReference[] = [];

  for (const [index, entry] of value.selection.entries()) {
    const key = findingKey(entry);
    const source = sources.get(key);
    const path = `selection[${index}]`;

    requireReduction(source !== undefined, path);
    requireReduction(
      new Set(entry.outputFindingIds).size === entry.outputFindingIds.length,
      path,
    );
    if (entry.disposition === "omitted") {
      requireReduction(
        entry.outputFindingIds.length === 0 &&
          (entry.reason?.trim().length ?? 0) > 0,
        path,
      );
      continue;
    }
    requireReduction(
      source.validity === "valid" || source.validity === "superseded",
      path,
    );
    requireReduction(
      entry.outputFindingIds.length > 0 &&
        (entry.disposition !== "retained" ||
          entry.outputFindingIds.length === 1),
      path,
    );
    for (const outputId of entry.outputFindingIds) {
      const output = outputs.get(outputId);

      requireReduction(
        output !== undefined &&
          output.sourceFindings.some((origin) => findingKey(origin) === key),
        path,
      );
      if (entry.disposition === "retained")
        requireReduction(
          output.assertion === source.finding.assertion &&
            output.basis === source.finding.basis,
          path,
        );
      else if (output.assertion !== source.finding.assertion)
        requireReduction(output.basis === "inferred", path);
      requireReduction(preservesSource(output, source.finding), path);
    }
    inherited.push(
      ...[...source.finding.supporting, ...source.finding.contradicting]
        .filter((reference) => reference.kind === "result")
        .map((reference) => ({ reference, childRunId: source.childRunId })),
    );
  }
  for (const [index, finding] of value.findings.entries()) {
    const keys = finding.sourceFindings.map(findingKey);

    requireReduction(
      new Set(keys).size === keys.length,
      `findings[${index}].sourceFindings`,
    );
    for (const key of keys) {
      const entry = selection.get(key);

      requireReduction(
        entry !== undefined &&
          entry.disposition !== "omitted" &&
          entry.outputFindingIds.includes(finding.id),
        `findings[${index}].sourceFindings`,
      );
    }
  }

  return inherited;
}

/** Inspect exact served revisions using the existing parent edge/result ledger; never introduce a second consumption ledger. */
export async function inspectFindingsReduction(
  tx: KnowledgeTransaction,
  runId: string,
  value: EvidenceFindingsV1,
): Promise<FindingsReduction> {
  const requested = new Map(
    [
      ...value.selection,
      ...value.findings.flatMap((finding) => finding.sourceFindings),
    ].map((origin) => [
      JSON.stringify([origin.childRunId, origin.resultRevision]),
      origin,
    ]),
  );

  requireReduction(requested.size <= MAX_SOURCE_FINDINGS, "selection");
  const named =
    requested.size === 0
      ? sql`false`
      : sql`(child.id,result.revision) IN (${sql.join(
          [...requested.values()].map(
            (origin) => sql`(${origin.childRunId},${origin.resultRevision})`,
          ),
          sql`, `,
        )})`;
  const metadata = (
    await tx.execute(sql`
    SELECT result.id,result.value_bytes+coalesce(octet_length(child.knowledge_access::text),0) AS input_bytes,
      child.result_contract->>'sha256'=result.schema_sha256 AND child.result_contract->>'schemaRef'=result.schema_ref AS contract_matches
    FROM runs child JOIN run_results result ON result.run_id=child.id
    WHERE child.parent_run_id=${runId} AND (
      (child.result_contract->>'nativeContract'=${FINDINGS_CONTRACT}
        AND child.result_contract->>'kind' IN ('agent_profile','flow_export'))
      OR (child.result_contract->>'nativeContract'=${OPERATIONAL_EVIDENCE_CONTRACT}
        AND child.result_contract->>'kind'='flow_export')
      OR (child.result_contract->>'kind'='agent_operational'
        AND child.result_contract->>'contractName'=${OPERATIONAL_EVIDENCE_CONTRACT})
    ) AND result.first_collected_at IS NOT NULL
      AND (result.revision=(SELECT max(consumed.revision) FROM run_results consumed WHERE consumed.run_id=child.id AND consumed.first_collected_at IS NOT NULL) OR ${named})
    ORDER BY child.id,result.revision LIMIT ${MAX_SOURCE_FINDINGS + 1} FOR SHARE OF child,result
  `)
  ).rows;

  requireReduction(
    metadata.length <= MAX_SOURCE_FINDINGS &&
      metadata.every((row) => row.contract_matches === true),
    "selection",
  );
  requireReduction(
    metadata.reduce((bytes, row) => bytes + Number(row.input_bytes), 0) <=
      MAX_REDUCTION_INPUT_BYTES,
    "selection",
  );
  const rows: readonly SourceRow[] =
    metadata.length === 0
      ? []
      : ((
          await tx.execute(sql`
    SELECT child.id AS child_run_id,result.revision,result.validity,
      CASE WHEN child.result_contract->>'kind'='agent_operational'
        THEN result.value->'findings' ELSE result.value END AS value,child.knowledge_access
    FROM run_results result JOIN runs child ON child.id=result.run_id
    WHERE result.id IN (${sql.join(
      metadata.map((row) => sql`${row.id}`),
      sql`, `,
    )}) AND child.parent_run_id=${runId}
    ORDER BY child.id,result.revision
  `)
        ).rows as unknown as readonly SourceRow[]);
  const sources = new Map<string, Source>();
  const restrictions: KnowledgeAccessRestriction[] = [];

  for (const row of rows) {
    const parsed = evidenceFindingsV1Schema.safeParse(row.value);
    const capture = knowledgeAccessCaptureSchema.safeParse(
      row.knowledge_access,
    );

    requireReduction(
      parsed.success && capture.success && capture.data.state === "complete",
      "selection",
    );
    restrictions.push(...capture.data.restrictions);
    for (const finding of parsed.data.findings) {
      sources.set(
        findingKey({
          childRunId: row.child_run_id,
          resultRevision: row.revision,
          findingId: finding.id,
        }),
        { finding, childRunId: row.child_run_id, validity: row.validity },
      );
    }
  }
  requireReduction(sources.size <= MAX_SOURCE_FINDINGS, "selection");

  return {
    hasSources: rows.length > 0,
    restrictions,
    inheritedResultReferences: validateSelection(value, sources),
  };
}
