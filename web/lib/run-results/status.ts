import type {
  ResultStatus,
  RunResultContract,
  RunResultInvalidReason,
  RunResultValidity,
} from "@/lib/run-results/types";

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

// A run in one of these has not finished, so its result is not an answer yet —
// whatever rows already exist. Kept as a local literal set rather than reusing
// `SETTLED_RUN_STATUSES`: that constant answers "may the coordinator wake?",
// which includes `Review`; this answers "is this run still working?", and the
// two would drift the moment either question changes.
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
]);

const FAILURE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "Failed",
  "Crashed",
  "Abandoned",
]);

export function deriveResultStatus(
  input: DeriveResultStatusInput,
): ResultStatus {
  const { runStatus, contract, newestRow, validRow } = input;

  if (LIVE_RUN_STATUSES.has(runStatus)) return "pending";

  // A failure-terminal run's result is never usable, even when a `valid` row
  // exists — the run did not finish, so what it published is not an answer.
  // `resultFailure` still surfaces from the newest `invalid` row separately.
  if (FAILURE_RUN_STATUSES.has(runStatus)) return "unavailable";

  // Review | Done, in the table's order: a current valid result wins over any
  // newer stale/invalid sibling.
  if (validRow) return "valid";
  if (newestRow?.validity === "stale") return "stale";
  if (newestRow?.validity === "invalid") return "invalid";

  // No usable row. `required` is what separates "this run was never asked for a
  // result" from "it owed one and a human path released it anyway".
  return contract?.required ? "missing" : "absent";
}
