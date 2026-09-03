import type { RunResultContract } from "@/lib/run-results/types";

import { describe, expect, it } from "vitest";

import {
  deriveResultStatus,
  FAILURE_RESULT_RUN_STATUSES,
  LIVE_RESULT_RUN_STATUSES,
  type DeriveResultStatusInput,
} from "@/lib/run-results/status";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";

// ADR-165 AC-09 / spec C-3.4. `resultStatus` is derived by exactly ONE
// predicate, consumed by the collect route, the run DTO and the Evaluation Lab.
// This is the table from docs/system-analytics/run-results.md §B, transcribed
// one row per outcome — all seven values, including the NULL-contract arm a
// scratch or manual run takes.

const REQUIRED_CONTRACT: RunResultContract = {
  kind: "flow_export",
  schemaRef: "pkg@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "a".repeat(64),
  required: true,
  producerNodeIds: ["orchestrate"],
  schema: { schemaVersion: 1, fields: [] },
  flowRevisionId: "rev-1",
};

const OPTIONAL_CONTRACT: RunResultContract = {
  ...REQUIRED_CONTRACT,
  required: false,
};

const AGENT_CONTRACT: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "pkg@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "b".repeat(64),
  required: true,
  schema: { schemaVersion: 1, fields: [] },
  sourceFlowRevisionId: "rev-1",
};

type Row = NonNullable<DeriveResultStatusInput["newestRow"]>;

function row(over: Partial<Row> = {}): Row {
  return {
    id: "rr-1",
    revision: 1,
    validity: "valid",
    invalidReason: null,
    ...over,
  } as Row;
}

const LIVE_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
] as const;

const FAILURE_STATUSES = ["Failed", "Crashed", "Abandoned"] as const;

// The predicate partitions `runs.status` into live / failure-terminal / settled.
// That partition is only correct while it stays EXHAUSTIVE: a 12th status added
// to the enum would fall through to the settled arm and report a result for a
// run that is still working. Pin it against the schema's own enum rather than a
// re-typed copy.
describe("the status partition covers the whole runs.status enum", () => {
  const ENUM_VALUES = [...RUN_STATUS_VALUES].sort();

  it("live + failure + settled = every value, with no overlap", () => {
    const live = [...LIVE_RESULT_RUN_STATUSES];
    const failure = [...FAILURE_RESULT_RUN_STATUSES];
    const settled = ENUM_VALUES.filter(
      (v) => !live.includes(v as never) && !failure.includes(v as never),
    );

    expect([...live, ...failure, ...settled].sort()).toEqual(ENUM_VALUES);
    expect(live.filter((v) => failure.includes(v as never))).toEqual([]);
    // The settled arm is exactly the two statuses whose results are readable.
    expect(settled.sort()).toEqual(["Done", "Review"]);
  });

  it("only Review/Done can report `valid`, over the whole enum", () => {
    const reportingValid = ENUM_VALUES.filter(
      (runStatus) =>
        deriveResultStatus({
          runStatus,
          contract: REQUIRED_CONTRACT,
          newestRow: row(),
          validRow: row(),
        }) === "valid",
    );

    expect(reportingValid.sort()).toEqual(["Done", "Review"]);
  });

  // The arm is an allow-list, so a status the predicate has never heard of
  // reads as still-working. A deny-list would fall through and publish a
  // result for it — the failure mode this guard exists for.
  it("an UNKNOWN status reads as pending, never as a publishable result", () => {
    expect(
      deriveResultStatus({
        runStatus: "SomeStatusAddedLater",
        contract: REQUIRED_CONTRACT,
        newestRow: row(),
        validRow: row(),
      }),
    ).toBe("pending");
  });
});

describe("deriveResultStatus (ADR-165 §B table)", () => {
  it.each(LIVE_STATUSES)(
    "%s → pending regardless of rows or contract",
    (runStatus) => {
      expect(
        deriveResultStatus({
          runStatus,
          contract: REQUIRED_CONTRACT,
          newestRow: row(),
          validRow: row(),
        }),
      ).toBe("pending");
      expect(
        deriveResultStatus({
          runStatus,
          contract: null,
          newestRow: null,
          validRow: null,
        }),
      ).toBe("pending");
    },
  );

  it.each(["Review", "Done"] as const)("%s with a valid row → valid", (s) => {
    expect(
      deriveResultStatus({
        runStatus: s,
        contract: REQUIRED_CONTRACT,
        newestRow: row(),
        validRow: row(),
      }),
    ).toBe("valid");
  });

  it.each(["Review", "Done"] as const)(
    "%s with a NULL contract and no rows → absent (a scratch or manual run)",
    (s) => {
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: null,
          newestRow: null,
          validRow: null,
        }),
      ).toBe("absent");
    },
  );

  it.each(["Review", "Done"] as const)(
    "%s with an OPTIONAL contract and no rows → absent",
    (s) => {
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: OPTIONAL_CONTRACT,
          newestRow: null,
          validRow: null,
        }),
      ).toBe("absent");
    },
  );

  it.each(["Review", "Done"] as const)(
    "%s with a REQUIRED contract and no rows → missing",
    (s) => {
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: REQUIRED_CONTRACT,
          newestRow: null,
          validRow: null,
        }),
      ).toBe("missing");
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: AGENT_CONTRACT,
          newestRow: null,
          validRow: null,
        }),
      ).toBe("missing");
    },
  );

  it.each(["Review", "Done"] as const)(
    "%s whose newest row is stale → stale",
    (s) => {
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: REQUIRED_CONTRACT,
          newestRow: row({ validity: "stale" }),
          validRow: null,
        }),
      ).toBe("stale");
    },
  );

  it.each(["Review", "Done"] as const)(
    "%s whose newest row is invalid → invalid",
    (s) => {
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: REQUIRED_CONTRACT,
          newestRow: row({ validity: "invalid", invalidReason: "oversize" }),
          validRow: null,
        }),
      ).toBe("invalid");
    },
  );

  // A `valid` row WINS over a newer stale/invalid sibling: the table's Review /
  // Done rows are ordered, and "a valid row exists" is checked first. Without
  // this case a naive implementation that only looked at `newestRow` would pass
  // every row above.
  it.each(["Review", "Done"] as const)(
    "%s with a valid row AND a newer invalid row → valid",
    (s) => {
      expect(
        deriveResultStatus({
          runStatus: s,
          contract: REQUIRED_CONTRACT,
          newestRow: row({
            id: "rr-2",
            revision: 2,
            validity: "invalid",
            invalidReason: "schema_mismatch",
          }),
          validRow: row(),
        }),
      ).toBe("valid");
    },
  );

  it.each(FAILURE_STATUSES)("%s → unavailable, whatever the rows say", (s) => {
    expect(
      deriveResultStatus({
        runStatus: s,
        contract: REQUIRED_CONTRACT,
        newestRow: row({
          validity: "invalid",
          invalidReason: "result_missing",
        }),
        validRow: null,
      }),
    ).toBe("unavailable");
    expect(
      deriveResultStatus({
        runStatus: s,
        contract: null,
        newestRow: null,
        validRow: null,
      }),
    ).toBe("unavailable");
    // Even a valid row loses to a failure-terminal status — the run did not
    // finish, so its result is not a usable answer.
    expect(
      deriveResultStatus({
        runStatus: s,
        contract: REQUIRED_CONTRACT,
        newestRow: row(),
        validRow: row(),
      }),
    ).toBe("unavailable");
  });
});
