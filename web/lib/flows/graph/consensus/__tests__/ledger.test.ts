import { describe, expect, it, vi } from "vitest";

const recordArtifact = vi.hoisted(() => vi.fn(async () => ({ id: "raw" })));
const getArtifactsForRun = vi.hoisted(() => vi.fn());

vi.mock("@/lib/flows/graph/artifact-store", () => ({
  getArtifactsForRun,
  recordArtifact,
}));

import { recordConsensusVerdict } from "@/lib/flows/graph/consensus/ledger";

function transactionDb(): {
  db: unknown;
  tx: { insert: ReturnType<typeof vi.fn> };
  transaction: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
} {
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const tx = {
    insert: vi.fn(() => ({ values })),
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(tx),
  );

  return {
    db: { transaction },
    tx,
    transaction,
    onConflictDoUpdate,
  };
}

describe("recordConsensusVerdict", () => {
  it("records verifier artifact and ledger row in one transaction", async () => {
    const { db, tx, transaction, onConflictDoUpdate } = transactionDb();

    const result = await recordConsensusVerdict({
      db,
      runId: "run-1",
      nodeId: "decide",
      nodeAttemptId: "attempt-1",
      attempt: 1,
      round: 1,
      verifierId: "architect",
      targetParticipantId: "qa",
      result: {
        parseStatus: "parsed",
        verdict: "agree",
        axes: { scope: true },
        disagreements: [],
      },
      rawOutput: '{"verdict":"agree"}',
    });

    expect(result.rawOutputArtifactId).toBe(
      "run:attempt-1:consensus-verdict:r1:architect:qa",
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run:attempt-1:consensus-verdict:r1:architect:qa",
      }),
      tx,
    );
    expect(tx.insert).toHaveBeenCalled();
    expect(onConflictDoUpdate).toHaveBeenCalled();
  });
});
