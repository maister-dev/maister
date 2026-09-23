import { describe, expect, it, vi } from "vitest";

const getArtifactsForRun = vi.hoisted(() => vi.fn());

vi.mock("@/lib/flows/graph/artifact-store", () => ({ getArtifactsForRun }));

import { recordConsensusVerdict } from "@/lib/flows/graph/consensus/ledger";

// The stored row as Postgres returns it: jsonb re-sorts object keys, so the
// axes come back in storage order, not the manifest order the writer used.
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    verifierKey: "architect",
    targetKey: "qa",
    round: 1,
    parseStatus: "invalid_json",
    verdict: "disagree",
    axes: { risk: false, scope: false },
    disagreements: { version: 1, rows: [], truncated: false },
    confidence: null,
    rawOutputArtifactId: "run:attempt-1:consensus-verdict:r1:architect:qa",
    errorCode: "draft_partial",
    ...overrides,
  };
}

function fakeDb(insertedCount: number, stored: Record<string, unknown>) {
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() =>
          Object.assign(Promise.resolve(undefined), {
            returning: vi.fn(async () =>
              Array.from({ length: insertedCount }, () => ({ id: "cell" })),
            ),
          }),
        ),
      })),
    })),
  };

  return {
    transaction: vi.fn(async (fn: (inner: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => [stored]) })),
    })),
  };
}

const write = {
  runId: "run-1",
  nodeId: "decide",
  nodeAttemptId: "attempt-1",
  attempt: 1,
  round: 1,
  verifierId: "architect",
  targetParticipantId: "qa",
  result: {
    parseStatus: "invalid_json" as const,
    verdict: "disagree" as const,
    axes: { scope: false, risk: false },
    disagreements: [],
  },
  rawOutput: "target draft partial: max_tokens",
  errorCode: "draft_partial",
};

describe("recordConsensusVerdict", () => {
  it("returns a fresh cell exactly as stored, so a replay serializes identically", async () => {
    const db = fakeDb(1, storedRow());

    const cell = await recordConsensusVerdict({ ...write, db });

    expect(Object.keys(cell.axes)).toEqual(["risk", "scope"]);
    expect(cell.errorCode).toBe("draft_partial");
  });

  it("returns the already-applied cell instead of refusing the unpaid write", async () => {
    const db = fakeDb(
      0,
      storedRow({
        parseStatus: "parsed",
        verdict: "agree",
        axes: { risk: true, scope: true },
        errorCode: null,
      }),
    );

    const cell = await recordConsensusVerdict({ ...write, db });

    expect(cell).toMatchObject({ parseStatus: "parsed", verdict: "agree" });
    expect(cell.errorCode).toBeUndefined();
  });
});
