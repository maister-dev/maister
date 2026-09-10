// T2.4 — the mapping seam for the crashed/flagged decision sources.
//
// This is a REDACTION PROOF, so it feeds the mapper a row that actually
// CONTAINS `acpSessionId` and asserts the exact output key set. A test fed an
// already-safe DTO literal proves nothing: a future `{ ...row }` spread would
// leak the session id with every such test still green.

import { describe, expect, it } from "vitest";

import {
  toCrashedDecisionItem,
  toFlaggedDecisionItem,
  type CrashedRunRow,
  type FlaggedTaskRow,
} from "@/lib/queries/decision-sources";

function crashedRow(over: Partial<CrashedRunRow> = {}): CrashedRunRow {
  return {
    runId: "run-1",
    projectId: "proj-1",
    projectSlug: "demo",
    taskId: "task-1",
    projectTaskKey: "DEMO",
    taskNumber: 14,
    taskTitle: "Backfill the pricing table",
    runKind: "flow",
    status: "Crashed",
    // The secret the mapper must drop. A real row carries it.
    acpSessionId: "sess_01H8XSUPERSECRET",
    crashedAt: new Date("2026-09-10T08:41:00.000Z"),
    ...over,
  };
}

const CRASHED_KEYS = [
  "runId",
  "projectId",
  "projectSlug",
  "taskId",
  "taskKey",
  "taskTitle",
  "action",
  "crashedAt",
].sort();

describe("toCrashedDecisionItem redacts the session handle", () => {
  it("emits exactly the public key set", () => {
    expect(Object.keys(toCrashedDecisionItem(crashedRow())).sort()).toEqual(
      CRASHED_KEYS,
    );
  });

  it("leaves no trace of the session id anywhere in the serialized item", () => {
    const json = JSON.stringify(toCrashedDecisionItem(crashedRow()));

    expect(json).not.toContain("sess_01H8XSUPERSECRET");
    expect(json).not.toMatch(/acpSessionId/i);
  });

  it("keeps redacting when the row gains an unexpected field", () => {
    const row = {
      ...crashedRow(),
      worktreePath: "/Users/someone/repos/private/.maister/demo/runs/run-1",
    } as CrashedRunRow;

    const json = JSON.stringify(toCrashedDecisionItem(row));

    expect(json).not.toContain("/Users/someone");
    expect(Object.keys(toCrashedDecisionItem(row)).sort()).toEqual(
      CRASHED_KEYS,
    );
  });
});

describe("toCrashedDecisionItem derives the operator's next action", () => {
  it("offers recover while a checkpoint handle survives", () => {
    expect(toCrashedDecisionItem(crashedRow()).action).toBe("recover");
  });

  it("offers discard once the handle is gone", () => {
    expect(
      toCrashedDecisionItem(crashedRow({ acpSessionId: null })).action,
    ).toBe("discard");
  });

  it("builds the task key from its two parts, or null when either is missing", () => {
    expect(toCrashedDecisionItem(crashedRow()).taskKey).toBe("DEMO-14");
    expect(
      toCrashedDecisionItem(crashedRow({ taskNumber: null })).taskKey,
    ).toBeNull();
    expect(
      toCrashedDecisionItem(crashedRow({ projectTaskKey: null })).taskKey,
    ).toBeNull();
  });
});

describe("toFlaggedDecisionItem", () => {
  function flaggedRow(over: Partial<FlaggedTaskRow> = {}): FlaggedTaskRow {
    return {
      taskId: "task-9",
      projectId: "proj-1",
      projectSlug: "demo",
      projectTaskKey: "DEMO",
      taskNumber: 9,
      taskTitle: "Clarify the refund window",
      triageConfidence: "0.42",
      flaggedAt: new Date("2026-09-09T10:00:00.000Z"),
      ...over,
    };
  }

  it("emits exactly the public key set", () => {
    expect(Object.keys(toFlaggedDecisionItem(flaggedRow())).sort()).toEqual(
      [
        "taskId",
        "projectId",
        "projectSlug",
        "taskKey",
        "taskTitle",
        "flaggedAt",
      ].sort(),
    );
  });

  it("drops the triage confidence, which is an internal advisory number", () => {
    const json = JSON.stringify(toFlaggedDecisionItem(flaggedRow()));

    expect(json).not.toContain("0.42");
    expect(json).not.toMatch(/confidence/i);
  });

  it("builds the task key the same way the crashed mapper does", () => {
    expect(toFlaggedDecisionItem(flaggedRow()).taskKey).toBe("DEMO-9");
    expect(
      toFlaggedDecisionItem(flaggedRow({ taskNumber: null })).taskKey,
    ).toBeNull();
  });
});
