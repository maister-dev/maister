import type { FlowYamlV1 } from "@/lib/config.schema";

import {
  validateDecideDraft,
  validateGateDraft,
  validateNodeDraft,
} from "@/lib/flows/editor/node-form";

export type EditorIssue = {
  nodeId: string;
  gateId?: string;
  path: string;
  message: string;
};

export type EditorValidationResult = {
  ok: boolean;
  issues: EditorIssue[];
};

/**
 * M27/T-A7: client-safe inline validation that maps each schema error to the
 * offending node (and gate). A preview/UX layer over the per-node zod — the
 * authoritative hard-gate is still `validateGraphManifest`+`compileManifest`
 * on save (server-side, T-A5). Node-level errors map to `nodeId`; gate errors
 * map to `nodeId`+`gateId` (gates are validated separately so the
 * human_review-not-blocking rule — absent from the base gate schema — is
 * surfaced, and the issue points at the gate rather than a `pre_finish.gates.N`
 * array index). The `decide` table (M38) is likewise validated separately so the
 * `when`-grammar rule — absent from the base schema — is surfaced; its issues map
 * to the `nodeId`.
 */
export function validateEditorManifest(
  manifest: FlowYamlV1,
): EditorValidationResult {
  const issues: EditorIssue[] = [];

  for (const node of manifest.nodes ?? []) {
    const nodeResult = validateNodeDraft(node);

    if (!nodeResult.ok) {
      for (const issue of nodeResult.errors) {
        // Gate errors are reported per-gate below (mapped to gateId).
        if (issue.path.startsWith("pre_finish.gates")) continue;
        // Decide errors are reported via validateDecideDraft below (it adds the
        // when-grammar rule the base node schema does not run).
        if (issue.path.startsWith("decide")) continue;
        issues.push({
          nodeId: node.id,
          path: issue.path,
          message: issue.message,
        });
      }
    }

    const decide = (node as { decide?: unknown }).decide;

    if (decide !== undefined) {
      const decideResult = validateDecideDraft(decide);

      if (!decideResult.ok) {
        for (const issue of decideResult.errors) {
          issues.push({
            nodeId: node.id,
            path: issue.path ? `decide.${issue.path}` : "decide",
            message: issue.message,
          });
        }
      }
    }

    for (const gate of node.pre_finish?.gates ?? []) {
      const gateResult = validateGateDraft(gate);

      if (!gateResult.ok) {
        for (const issue of gateResult.errors) {
          issues.push({
            nodeId: node.id,
            gateId: gate.id,
            path: issue.path,
            message: issue.message,
          });
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
