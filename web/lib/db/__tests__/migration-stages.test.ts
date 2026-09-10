import { describe, expect, it } from "vitest";

import { findMainMigrationJournalEntry } from "@/lib/db/check-migrations";
import {
  EXECUTION_AB_STAGES,
  EXECUTION_AB_STAGE_NAMES,
  assessLegacyImportWindow,
  classifyDataPlaneStage,
  isExecutionAbStage,
  planExecutionAbStage,
  type ExecutionAbStage,
} from "@/lib/db/migration-stages";

// A synthetic journal with the three real Stage A/B boundary tags in their real
// order, so the planner is exercised without depending on the 160-entry file.
const journal = [
  { idx: 0, tag: "0130_execution_hosts", when: 100 },
  { idx: 1, tag: "0131_foamy_venom", when: 200 },
  { idx: 2, tag: "0132_soft_loa", when: 300 },
  { idx: 3, tag: "0133_rich_blob", when: 400 },
  { idx: 4, tag: "0134_lovely_tarot", when: 500 },
  { idx: 5, tag: "0135_lush_jetstream", when: 600 },
  { idx: 6, tag: "0136_shiny_the_executioner", when: 700 },
  { idx: 7, tag: "0137_later_forward_fix", when: 800 },
];

function plan(
  stage: ExecutionAbStage,
  pending: readonly string[],
  ledgerHighWater: number | null,
) {
  return planExecutionAbStage({ stage, journal, pending, ledgerHighWater });
}

describe("execution A/B migration stages", () => {
  it("accepts exactly the three documented operator stage names", () => {
    expect([...EXECUTION_AB_STAGE_NAMES]).toEqual([
      "execution-ab-additive",
      "execution-ab-associations",
      "execution-ab-finalize",
    ]);
    expect(isExecutionAbStage("execution-ab-additive")).toBe(true);
    expect(isExecutionAbStage("execution-ab")).toBe(false);
    expect(isExecutionAbStage("0134_lovely_tarot")).toBe(false);
  });

  it("bounds the additive stage at the last additive migration", () => {
    expect(EXECUTION_AB_STAGES["execution-ab-additive"].boundaryTag).toBe(
      "0133_rich_blob",
    );
    expect(EXECUTION_AB_STAGES["execution-ab-associations"].boundaryTag).toBe(
      "0134_lovely_tarot",
    );
    expect(EXECUTION_AB_STAGES["execution-ab-finalize"].boundaryTag).toBeNull();
  });

  it("plans the additive stage up to 0133 and never past it", () => {
    const result = plan(
      "execution-ab-additive",
      [
        "0131_foamy_venom",
        "0132_soft_loa",
        "0133_rich_blob",
        "0134_lovely_tarot",
        "0135_lush_jetstream",
        "0136_shiny_the_executioner",
        "0137_later_forward_fix",
      ],
      100,
    );

    expect(result).toEqual({
      outcome: "apply",
      stage: "execution-ab-additive",
      boundaryTag: "0133_rich_blob",
      plannedTags: ["0131_foamy_venom", "0132_soft_loa", "0133_rich_blob"],
      withheldTags: [
        "0134_lovely_tarot",
        "0135_lush_jetstream",
        "0136_shiny_the_executioner",
        "0137_later_forward_fix",
      ],
    });
  });

  it("reports a stage whose migrations are already committed as satisfied", () => {
    expect(
      plan("execution-ab-additive", ["0134_lovely_tarot"], 400),
    ).toMatchObject({
      outcome: "satisfied",
      stage: "execution-ab-additive",
    });
  });

  it("plans the association stage as 0134 alone", () => {
    expect(
      plan(
        "execution-ab-associations",
        [
          "0134_lovely_tarot",
          "0135_lush_jetstream",
          "0136_shiny_the_executioner",
        ],
        400,
      ),
    ).toMatchObject({
      outcome: "apply",
      plannedTags: ["0134_lovely_tarot"],
      withheldTags: ["0135_lush_jetstream", "0136_shiny_the_executioner"],
    });
  });

  it("plans the finalize stage as every remaining migration", () => {
    expect(
      plan(
        "execution-ab-finalize",
        [
          "0135_lush_jetstream",
          "0136_shiny_the_executioner",
          "0137_later_forward_fix",
        ],
        500,
      ),
    ).toMatchObject({
      outcome: "apply",
      boundaryTag: null,
      plannedTags: [
        "0135_lush_jetstream",
        "0136_shiny_the_executioner",
        "0137_later_forward_fix",
      ],
      withheldTags: [],
    });
  });

  it("refuses a stage whose prerequisite migrations are still pending", () => {
    expect(
      plan(
        "execution-ab-associations",
        ["0133_rich_blob", "0134_lovely_tarot"],
        300,
      ),
    ).toMatchObject({
      outcome: "refused",
      reason: "stage_out_of_order",
      blockedTags: ["0133_rich_blob"],
    });
    expect(
      plan(
        "execution-ab-finalize",
        ["0134_lovely_tarot", "0135_lush_jetstream"],
        400,
      ),
    ).toMatchObject({
      outcome: "refused",
      reason: "stage_out_of_order",
      blockedTags: ["0134_lovely_tarot"],
    });
  });

  it("refuses a planned migration the ledger high-water would silently skip", () => {
    expect(
      plan(
        "execution-ab-additive",
        ["0132_soft_loa", "0134_lovely_tarot"],
        400,
      ),
    ).toMatchObject({
      outcome: "refused",
      reason: "ledger_high_water_drift",
      blockedTags: ["0132_soft_loa"],
    });
  });

  it("carries a remediation code on every refusal", () => {
    for (const refusal of [
      plan("execution-ab-associations", ["0133_rich_blob"], 300),
      plan("execution-ab-additive", ["0132_soft_loa"], 400),
    ]) {
      expect(refusal.outcome).toBe("refused");
      expect(refusal).toHaveProperty("remediation");
      expect(
        (refusal as { remediation: string }).remediation.length,
      ).toBeGreaterThan(0);
    }
  });

  it("names boundary tags that exist in the committed main journal", () => {
    for (const stage of EXECUTION_AB_STAGE_NAMES) {
      const boundaryTag = EXECUTION_AB_STAGES[stage].boundaryTag;

      if (boundaryTag) {
        expect(findMainMigrationJournalEntry(boundaryTag)).not.toBeNull();
      }

      const prerequisiteTag = EXECUTION_AB_STAGES[stage].prerequisiteTag;

      if (prerequisiteTag) {
        expect(findMainMigrationJournalEntry(prerequisiteTag)).not.toBeNull();
      }
    }
  });
});

// The legacy importer runs between the additive stage and the finalize stage
// (D9 steps 4-8: it also restores the scratch lane AFTER 0134). Its window is
// read from the schema the database actually carries, never from the ledger --
// a partially staged database is exactly where the ledger is least trustworthy.
describe("legacy import window", () => {
  it("classifies the data-plane stage from committed schema evidence", () => {
    expect(
      classifyDataPlaneStage({
        importLanes: false,
        scratchMirror: true,
        artifactProjectionCursors: true,
      }),
    ).toBe("pre-additive");
    expect(
      classifyDataPlaneStage({
        importLanes: true,
        scratchMirror: true,
        artifactProjectionCursors: true,
      }),
    ).toBe("additive");
    expect(
      classifyDataPlaneStage({
        importLanes: true,
        scratchMirror: false,
        artifactProjectionCursors: true,
      }),
    ).toBe("associations");
    expect(
      classifyDataPlaneStage({
        importLanes: true,
        scratchMirror: false,
        artifactProjectionCursors: false,
      }),
    ).toBe("canonical");
  });

  it("admits the import between the additive and finalize stages", () => {
    expect(assessLegacyImportWindow("additive")).toEqual({ admitted: true });
    expect(assessLegacyImportWindow("associations")).toEqual({
      admitted: true,
    });
  });

  it("refuses an unstaged database with the stage to run first", () => {
    expect(assessLegacyImportWindow("pre-additive")).toMatchObject({
      admitted: false,
      reason: "additive_stage_missing",
    });
    expect(
      (assessLegacyImportWindow("pre-additive") as { remediation: string })
        .remediation,
    ).toContain("execution-ab-additive");
  });

  it("refuses a database that already completed the canonical cut-over", () => {
    expect(assessLegacyImportWindow("canonical")).toMatchObject({
      admitted: false,
      reason: "already_canonical",
    });
  });
});
