import type {
  RunResultContract,
  RunResultInvalidReason,
} from "@/lib/run-results/types";

import { extractSentinelBlock } from "@/lib/flows/graph/node-output";
import { nodeOutputMaxBytes } from "@/lib/instance-config";
import { validateResultValue } from "@/lib/run-results/validate";

// ADR-165 (T5.4 / D10): the agent-run publish decision, as a PURE function.
//
// It is separated from `finalizeAgentRun` so the D10 table can be table-tested
// directly, and so the finalizer's transaction body reads as one branch on a
// decided outcome rather than a nested parse/validate/classify block wedged
// between a CAS and an emit.

export type AgentResultDecision =
  /** No contract, or an outcome that never publishes. */
  | { kind: "none" }
  /** An OPTIONAL contract with nothing emitted — settle normally. */
  | { kind: "absent" }
  | { kind: "valid"; value: Record<string, unknown>; valueBytes: number }
  | { kind: "invalid"; reason: RunResultInvalidReason; message: string };

export function decideAgentResult(args: {
  contract: RunResultContract;
  finalText: string | undefined;
  /** Overridable for tests; defaults to the instance cap. */
  maxBytes?: number;
}): AgentResultDecision {
  const block = extractSentinelBlock(
    args.finalText ?? "",
    // The sentinel extractor takes the SAME cap the flow-node path uses: a
    // block whose closing fence fell past the capture ceiling is not a block,
    // and reads as absent rather than as a truncated parse.
    args.maxBytes ?? nodeOutputMaxBytes(),
  );

  if (block.kind === "absent") {
    // `required` excuses ABSENCE only — and an agent contract is always
    // required, because the delegation explicitly asked for a profile.
    return args.contract.required
      ? {
          kind: "invalid",
          reason: "result_missing",
          message:
            "the agent finished without emitting a ```json maister:output block, but its delegation requires a public result",
        }
      : { kind: "absent" };
  }

  if (block.kind === "invalid") {
    // The extractor already applied the byte cap and the JSON parse; classify
    // by the same vocabulary the flow path uses.
    return {
      kind: "invalid",
      reason: block.reason.includes("exceeds") ? "oversize" : "malformed_json",
      message: block.reason,
    };
  }

  const verdict = validateResultValue({
    raw: JSON.stringify(block.value),
    schema: args.contract.schema,
    maxBytes: args.maxBytes ?? nodeOutputMaxBytes(),
    label: "public result",
  });

  if (!verdict.ok) {
    return {
      kind: "invalid",
      reason: verdict.reason,
      message: verdict.message,
    };
  }

  return {
    kind: "valid",
    value: verdict.value,
    valueBytes: verdict.valueBytes,
  };
}
