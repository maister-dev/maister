import { LEGACY_LANES, type LegacyLane } from "./sources";

// S4.5 / D9 steps 8-9. The phases before this one move bytes and repoint rows;
// this is the only thing that decides whether what the host now serves is what
// the operator froze. It is a pure fold on purpose: every refusal a lane can
// carry is produced by the caller's evidence, never by the reducer reaching for
// a database or a socket of its own, so a proof can be recomputed from its
// inputs and audited without re-running the import.

export const IMPORT_PROOF_VERSION = 1;

export type ProofRefusal =
  | "verify_bytes_missing"
  | "verify_hash_mismatch"
  | "verify_source_changed"
  | "verify_association_drifted"
  | "verify_scratch_count_mismatch"
  | "verify_item_unsealed"
  | "verify_count_mismatch"
  | "verify_rows_missing"
  | "verify_rows_mismatch"
  | "verify_catalog_missing"
  | "verify_catalog_mismatch"
  | "proof_lane_missing";

export type LaneExpectation = {
  runId: string;
  lane: LegacyLane;
  manifestDigest: string;
  expectedItems: number;
  totalBytes: number;
};

export type ItemOutcome = {
  itemId: string;
  runId: string;
  lane: LegacyLane;
  sizeBytes: number;
  refusal: ProofRefusal | null;
};

export type RunRefusal = {
  runId: string;
  lane: LegacyLane;
  refusal: ProofRefusal;
};

export type LaneProof = {
  lane: LegacyLane;
  fingerprint: string;
  position: string;
  expectedItems: number;
  verifiedItems: number;
  expectedBytes: number;
  verifiedBytes: number;
  refusals: readonly ProofRefusal[];
};

export type RunProof = {
  runId: string;
  proofVersion: number;
  holds: boolean;
  lanes: readonly LaneProof[];
  refusals: readonly string[];
};

// A lane that was never inspected has no fingerprint to stand on, so it cannot
// borrow one. It is reported at zero with the refusal that says why.
const MISSING_LANE_FINGERPRINT = "";

export function reduceRunProofs(input: {
  runIds: readonly string[];
  expectations: readonly LaneExpectation[];
  items: readonly ItemOutcome[];
  runRefusals: readonly RunRefusal[];
}): RunProof[] {
  const expectationsByRun = new Map<string, Map<LegacyLane, LaneExpectation>>();

  for (const expectation of input.expectations) {
    const lanes =
      expectationsByRun.get(expectation.runId) ??
      new Map<LegacyLane, LaneExpectation>();

    lanes.set(expectation.lane, expectation);
    expectationsByRun.set(expectation.runId, lanes);
  }

  return input.runIds.map((runId) => {
    const lanes = expectationsByRun.get(runId) ?? new Map();
    const proofs: LaneProof[] = LEGACY_LANES.map((lane) => {
      const expectation = lanes.get(lane) ?? null;
      const laneItems = input.items.filter(
        (item) => item.runId === runId && item.lane === lane,
      );
      const verified = laneItems.filter((item) => item.refusal === null);
      const refusals: ProofRefusal[] = [
        ...new Set([
          ...laneItems.flatMap((item) => (item.refusal ? [item.refusal] : [])),
          ...input.runRefusals
            .filter((entry) => entry.runId === runId && entry.lane === lane)
            .map((entry) => entry.refusal),
        ]),
      ];

      if (!expectation) refusals.push("proof_lane_missing");

      const verifiedBytes = verified.reduce(
        (total, item) => total + item.sizeBytes,
        0,
      );

      // A count that disagrees with the frozen manifest while no item explained
      // why is the shape a false proof takes: something was dropped between the
      // manifest and the evidence, and the lane must not pass on the strength
      // of the items that happen to remain.
      if (
        expectation &&
        verified.length !== expectation.expectedItems &&
        refusals.length === 0
      )
        refusals.push("verify_count_mismatch");

      return {
        lane,
        fingerprint: expectation?.manifestDigest ?? MISSING_LANE_FINGERPRINT,
        position: `items:${verified.length};bytes:${verifiedBytes}`,
        expectedItems: expectation?.expectedItems ?? 0,
        verifiedItems: verified.length,
        expectedBytes: expectation?.totalBytes ?? 0,
        verifiedBytes,
        refusals,
      };
    });

    const refusals = proofs.flatMap((proof) =>
      proof.refusals.map((refusal) => `${proof.lane}:${refusal}`),
    );

    return {
      runId,
      proofVersion: IMPORT_PROOF_VERSION,
      holds: refusals.length === 0,
      lanes: proofs,
      refusals,
    };
  });
}
