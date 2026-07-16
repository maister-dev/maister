// Controlled Evaluation Recipe parse + contract-digest helpers (M47, ADR-143
// D16). The recipe's `flow.inputContractDigest` / `flow.artifactContractDigest`
// are captured at recipe-freeze time from the selected Flow revision's contract.
// Preflight (and launch) recompute the same digests from the LIVE revision and
// refuse a mismatch — that is how a stale package revision is caught before any
// worktree side effect (D16 "stale package revision → typed refusal").
//
// Client-safe: no `server-only`. The digest is a pure content hash; the parse is
// a strict zod validation reused by the creation UI and the server services.

import { contentDigest } from "@/lib/evaluations/digest";
import {
  evaluationRecipeDefinitionSchema,
  type EvaluationControlledRecipeDefinition,
} from "@/lib/evaluations/recipe-schema";
import { MaisterError } from "@/lib/errors-core";

// A projection of the selected Flow revision's input/output contract, reduced to
// the exact-compat fields M47's first scope checks. The full projection from the
// live flow manifest (form_schema, produces[], stable slots) is assembled by the
// preflight route; this shape is the deterministic digest input so freeze-time
// and preflight-time digests are comparable.
export interface FlowContractProjection {
  // Ordered required task fields the Flow's input contract demands.
  requiredTaskFields: string[];
  // The Flow's declared form fields (required + optional). Exact-compat: a recipe
  // may not supply an unknown field.
  formRequiredFields: string[];
  formKnownFields: string[];
  // Artifact kinds the Flow's output contract guarantees to produce.
  producedArtifactKinds: string[];
  // Stable session/consensus slot keys the Flow declares.
  slotKeys: string[];
}

// Deterministic input-contract digest: the fields a recipe's inputs must satisfy.
export function computeInputContractDigest(
  flow: FlowContractProjection,
): string {
  return contentDigest({
    requiredTaskFields: [...flow.requiredTaskFields].sort(),
    formRequiredFields: [...flow.formRequiredFields].sort(),
    formKnownFields: [...flow.formKnownFields].sort(),
  });
}

// Deterministic artifact/output-contract digest.
export function computeArtifactContractDigest(
  flow: FlowContractProjection,
): string {
  return contentDigest({
    producedArtifactKinds: [...flow.producedArtifactKinds].sort(),
    slotKeys: [...flow.slotKeys].sort(),
  });
}

// Strict-parse a raw recipe definition into the typed controlled shape. An
// unknown key (including an arbitrary transform/mapping script), a missing
// required field, or a non-`evaluation_study` promotion hold is a CONFIG refusal
// — never a silent drop (D16, D15 forced hold).
export function parseControlledRecipe(
  raw: unknown,
): EvaluationControlledRecipeDefinition {
  const parsed = evaluationRecipeDefinitionSchema.safeParse(raw);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid controlled evaluation recipe: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}
