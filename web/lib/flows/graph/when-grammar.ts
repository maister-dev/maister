// `when`-predicate grammar v1 for the M38 `decide` table (ADR-103). A pure
// module — no I/O, no logger — so it is trivially testable and safe to call on
// the routing hot path. Routing-decision DEBUG logging happens at the
// runner-graph call sites (where the node-scoped `log2` child logger lives),
// never here.
//
// Grammar v1: ONE predicate per case — "<field> <op> <number>". `<field>` is a
// nested dot-path resolved by the shared safe getter `getPath`, which
// `decide:{from:output.<path>}` reuses for outcome resolution. AND/OR compound
// predicates are explicit future headroom, NOT v1.

export type WhenOp = ">=" | ">" | "<=" | "<" | "==" | "!=";

export type Predicate = {
  // A nested dot-path into the routing context, e.g. "confidence" or
  // "verdict.confidence".
  field: string;
  op: WhenOp;
  rhs: number;
};

export type ParseWhenResult =
  | { ok: true; predicate: Predicate }
  | { ok: false; error: string };

// Walk `dotpath` ("a.b.c") into `obj`. A null/non-object hop, or a segment the
// current object does not OWN, yields `undefined`. Never throws. `Object.hasOwn`
// (not `in`) so an inherited prototype key (`toString`/`constructor`/`valueOf`)
// can never resolve. Shared by `when` lhs resolution AND
// `decide:{from:output.<path>}` outcome resolution.
export function getPath(obj: unknown, dotpath: string): unknown {
  if (dotpath.length === 0) return undefined;

  let cur: unknown = obj;

  for (const seg of dotpath.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.hasOwn(cur as object, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }

  return cur;
}

// Identifier dot-path: seg('.'seg)*, seg = [A-Za-z_][A-Za-z0-9_]*. Two-char ops
// MUST precede one-char ops in the alternation so ">=" never parses as ">".
const WHEN_RE =
  /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(>=|<=|==|!=|>|<)\s*(-?(?:\d+\.\d+|\d+|\.\d+))$/;

// Parse "<field> <op> <number>". Whitespace-tolerant around the operator and at
// the ends. Returns a typed error (never throws) on any malformed input.
export function parseWhen(input: string): ParseWhenResult {
  const s = input.trim();
  const m = WHEN_RE.exec(s);

  if (m === null) {
    return {
      ok: false,
      error: `invalid \`when\` predicate "${input}" — expected "<field> <op> <number>" with op ∈ { >= > <= < == != }`,
    };
  }

  const rhs = Number(m[3]);

  if (!Number.isFinite(rhs)) {
    return { ok: false, error: `invalid \`when\` predicate "${input}" — right-hand side is not a finite number` };
  }

  return { ok: true, predicate: { field: m[1], op: m[2] as WhenOp, rhs } };
}

// Evaluate a parsed predicate against a routing context. The lhs is resolved by
// `getPath`; a missing or non-numeric lhs is a NO-MATCH (false), never a throw —
// so an absent optional field routes via the `default` case instead of crashing
// the run.
export function evalWhen(pred: Predicate, ctx: unknown): boolean {
  const lhs = getPath(ctx, pred.field);

  if (typeof lhs !== "number" || !Number.isFinite(lhs)) return false;

  switch (pred.op) {
    case ">=":
      return lhs >= pred.rhs;
    case ">":
      return lhs > pred.rhs;
    case "<=":
      return lhs <= pred.rhs;
    case "<":
      return lhs < pred.rhs;
    case "==":
      return lhs === pred.rhs;
    case "!=":
      return lhs !== pred.rhs;
  }
}
