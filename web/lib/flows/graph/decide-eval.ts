import type { DecideDef } from "@/lib/config.schema";

import { evalWhen, getPath, parseWhen } from "./when-grammar";

// The verdict object a `decide:{from:verdict}` node routes on — the calibrated
// gate verdict surfaced out of `runNodeGates` (GateRunResult.verdict). Exposes
// `verdict` (string) + `confidence` (number?) at the top level; `when` fields
// resolve against it via the shared `getPath`.
export type DecideVerdict = {
  verdict?: string;
  confidence?: number;
} & Record<string, unknown>;

export type ComputeDecideOutcomeArgs = {
  // The node's compiled `decide` table, or undefined for a plain node.
  decide: DecideDef | undefined;
  // The node attempt's `vars` (M26 validated structured output folded in).
  vars: Record<string, unknown>;
  // The verdict surfaced by the verdict-producing gate, for `from: verdict`.
  verdict?: DecideVerdict;
  // Today's outcome when `decide` is absent ("success" or a human decision).
  legacy: string;
};

// Compute a node's routing outcome (M38, ADR-103). PURE + TOTAL — never throws.
//
// - No `decide` → the legacy outcome (byte-identical to today).
// - `from: output.<path>` → `String(getPath(vars, <path>))`; a missing/null value
//   returns `undefined` (a graceful terminal — the caller routes it to
//   terminal/Review, NOT a CONFIG fail).
// - `from: verdict` → the first `cases` entry whose `when` matches the verdict
//   object, else the single `default`. A missing/non-numeric `when` lhs is a
//   no-match (falls through to default), never a throw.
//
// The caller applies the runtime allow-list guard (a PRESENT outcome ∉ the node's
// transition keys → CONFIG) and the existing transition resolution.
export function computeDecideOutcome(
  args: ComputeDecideOutcomeArgs,
): string | undefined {
  const { decide, vars, verdict, legacy } = args;

  if (decide === undefined) return legacy;

  if (decide.from === "verdict") {
    const ctx: unknown = verdict ?? {};

    for (const c of decide.cases ?? []) {
      if ("when" in c) {
        const parsed = parseWhen(c.when);

        if (parsed.ok && evalWhen(parsed.predicate, ctx)) return c.target;
      }
    }

    // No `when` matched → the single `default` (schema-guaranteed to exist).
    const def = (decide.cases ?? []).find((c) => !("when" in c)) as
      | { default: true; target: string }
      | undefined;

    return def?.target;
  }

  // from: output.<dot.path>
  const dotpath = decide.from.slice("output.".length);
  const raw = getPath(vars, dotpath);

  return raw === undefined || raw === null ? undefined : String(raw);
}
