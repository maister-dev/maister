import type { FormSchema } from "@/lib/config.schema";
import type { RunResultInvalidReason } from "@/lib/run-results/types";

import { validateStructuredOutput } from "@/lib/flows/output-schema";

// ADR-165 (C-7): the result value reuses the ADR-162 limits through ONE
// validator. This module is a thin COMPOSITION over `validateStructuredOutput`
// — byte cap, JSON parse, then the existing structural + field checks. There is
// deliberately no second validator and no second limit: a result and a node
// output are the same grammar, and two implementations would drift the first
// time either limit moved.
//
// What this adds over the node seam is CLASSIFICATION: the seam only needs a
// message, while a result row must persist a machine-readable
// `invalid_reason` a coordinator branches on.

export type ValidateResultOutcome =
  | { ok: true; value: Record<string, unknown>; valueBytes: number }
  | { ok: false; reason: RunResultInvalidReason; message: string };

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Validate a RAW result payload (the sentinel block's text, or a serialized
 * value) against the contract's schema.
 *
 * `maxBytes` is the caller's `MAISTER_NODE_OUTPUT_MAX_BYTES` — passed in rather
 * than read here so this stays pure and the cap has exactly one reader.
 */
export function validateResultValue(args: {
  raw: string;
  schema: FormSchema;
  maxBytes: number;
  /** Prefixes messages so a caller can tell WHICH payload failed. */
  label?: string;
}): ValidateResultOutcome {
  const label = args.label ?? "result";
  const valueBytes = Buffer.byteLength(args.raw, "utf8");

  if (valueBytes > args.maxBytes) {
    return {
      ok: false,
      reason: "oversize",
      message: `${label} is ${valueBytes} bytes — exceeds MAISTER_NODE_OUTPUT_MAX_BYTES (${args.maxBytes})`,
    };
  }

  const text = stripBom(args.raw).trim();

  if (text.length === 0) {
    return {
      ok: false,
      reason: "malformed_json",
      message: `${label} is empty`,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    return {
      ok: false,
      reason: "malformed_json",
      message: `${label} is not valid JSON: ${(err as Error).message}`,
    };
  }

  return validateParsedResultValue({ ...args, value: parsed, valueBytes });
}

/**
 * The same contract for an ALREADY-PARSED value — the flow-node path, where the
 * seam has parsed and structurally checked the payload before this module sees
 * it. Byte accounting uses the serialized form so a row's `value_bytes` means
 * the same thing on both paths.
 */
export function validateParsedResultValue(args: {
  value: unknown;
  schema: FormSchema;
  maxBytes: number;
  label?: string;
  valueBytes?: number;
}): ValidateResultOutcome {
  const label = args.label ?? "result";
  const serialized = JSON.stringify(args.value) ?? "";
  const valueBytes = args.valueBytes ?? Buffer.byteLength(serialized, "utf8");

  if (valueBytes > args.maxBytes) {
    return {
      ok: false,
      reason: "oversize",
      message: `${label} is ${valueBytes} bytes — exceeds MAISTER_NODE_OUTPUT_MAX_BYTES (${args.maxBytes})`,
    };
  }

  const verdict = validateStructuredOutput(args.value, args.schema);

  if (!verdict.ok) {
    return {
      // The validator reports the structural CLASS directly; a field-level
      // failure carries none, and `schema_mismatch` is the honest default for
      // it — the payload did not satisfy the declared contract.
      ok: false,
      reason: verdict.reason ?? "schema_mismatch",
      message: `${label}: ${verdict.message}`,
    };
  }

  return {
    ok: true,
    value: args.value as Record<string, unknown>,
    valueBytes,
  };
}
