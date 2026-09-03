import type {
  ResultStatus,
  RunResultContract,
  RunResultInvalidReason,
  RunResultValidity,
} from "@/lib/run-results/types";
import type { RunStatusValue } from "@/lib/runs/run-status-values";

import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";

// ADR-165 (§B): the ONE `resultStatus` predicate. The collect route, the run DTO
// and the Evaluation Lab all call it — a second derivation is how two surfaces
// start disagreeing about whether a child produced anything.
//
// Deliberately pure and dependency-free (no db, no `server-only`) so it can be
// table-tested and reused on any surface.

/** The subset of a `run_results` row the predicate needs. */
export type ResultStatusRow = {
  id: string;
  revision: number;
  validity: RunResultValidity;
  invalidReason: RunResultInvalidReason | null;
};

export type DeriveResultStatusInput = {
  runStatus: string;
  contract: RunResultContract | null;
  /** Highest-revision row for the run, whatever its validity. */
  newestRow: ResultStatusRow | null;
  /** The current `valid` row, if one exists (at most one per run). */
  validRow: ResultStatusRow | null;
};

// The predicate partitions `runs.status` into three arms. They are named for
// THIS concern — `SETTLED_RUN_STATUSES` answers "may the coordinator wake?" and
// includes `Review`, which is readable here — but they are DERIVED from the
// schema's enum rather than re-typed, so a status added to the column cannot
// silently land in the settled arm and report a result for a run that is still
// working.

/** Failure-terminal: the run did not finish, so nothing it published is an answer. */
export const FAILURE_RESULT_RUN_STATUSES = [
  "Failed",
  "Crashed",
  "Abandoned",
] as const satisfies readonly RunStatusValue[];

/** The two statuses whose results are readable. Everything else is still working. */
const SETTLED_RESULT_RUN_STATUSES = [
  "Review",
  "Done",
] as const satisfies readonly RunStatusValue[];

/**
 * Still working — derived as the complement, so it needs no maintenance when the
 * enum grows.
 */
export const LIVE_RESULT_RUN_STATUSES = RUN_STATUS_VALUES.filter(
  (s): s is RunStatusValue =>
    !(FAILURE_RESULT_RUN_STATUSES as readonly string[]).includes(s) &&
    !(SETTLED_RESULT_RUN_STATUSES as readonly string[]).includes(s),
);

const FAILURE_RUN_STATUSES: ReadonlySet<string> = new Set(
  FAILURE_RESULT_RUN_STATUSES,
);

const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set(
  SETTLED_RESULT_RUN_STATUSES,
);

export function deriveResultStatus(
  input: DeriveResultStatusInput,
): ResultStatus {
  const { runStatus, contract, newestRow, validRow } = input;

  // A failure-terminal run's result is never usable, even when a `valid` row
  // exists — the run did not finish, so what it published is not an answer.
  // `resultFailure` still surfaces from the newest `invalid` row separately.
  if (FAILURE_RUN_STATUSES.has(runStatus)) return "unavailable";

  // The readable arm is an ALLOW-LIST, not the fallthrough. `runStatus` is a
  // plain string at this boundary, so a status this predicate has never heard
  // of — a newly added enum value, a caller passing something else — must land
  // on the SAFE side and read as "still working", never as a publishable
  // result. A deny-list here would report `valid` for it.
  if (!SETTLED_RUN_STATUSES.has(runStatus)) return "pending";

  // Review | Done, in the table's order: a current valid result wins over any
  // newer stale/invalid sibling.
  if (validRow) return "valid";
  if (newestRow?.validity === "stale") return "stale";
  if (newestRow?.validity === "invalid") return "invalid";

  // No usable row. `required` is what separates "this run was never asked for a
  // result" from "it owed one and a human path released it anyway".
  return contract?.required ? "missing" : "absent";
}
