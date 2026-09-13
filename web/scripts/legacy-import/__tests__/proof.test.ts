import { describe, expect, it } from "vitest";

import {
  IMPORT_PROOF_VERSION,
  reduceRunProofs,
  type ItemOutcome,
  type LaneExpectation,
} from "../proof";
import { LEGACY_LANES, type LegacyLane } from "../sources";

const RUN = "run-1";

function expectations(
  overrides: Partial<Record<LegacyLane, Partial<LaneExpectation>>> = {},
  omit: readonly LegacyLane[] = [],
): LaneExpectation[] {
  return LEGACY_LANES.filter((lane) => !omit.includes(lane)).map((lane) => ({
    runId: RUN,
    lane,
    manifestDigest: `digest-${lane}`,
    expectedItems: 0,
    totalBytes: 0,
    ...overrides[lane],
  }));
}

function item(overrides: Partial<ItemOutcome> = {}): ItemOutcome {
  return {
    itemId: "item-1",
    runId: RUN,
    lane: "runtime_objects",
    sizeBytes: 10,
    refusal: null,
    ...overrides,
  };
}

function laneOf(
  proofs: ReturnType<typeof reduceRunProofs>,
  lane: LegacyLane,
): (typeof proofs)[number]["lanes"][number] {
  const found = proofs[0].lanes.find((entry) => entry.lane === lane);

  if (!found) throw new Error(`no ${lane} lane in the proof`);

  return found;
}

describe("reduceRunProofs", () => {
  it("holds when every lane meets the expectation the manifest froze", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN],
      expectations: expectations({
        runtime_objects: { expectedItems: 1, totalBytes: 10 },
      }),
      items: [item()],
      runRefusals: [],
    });

    expect(proofs[0].holds).toBe(true);
    expect(proofs[0].refusals).toEqual([]);
    expect(proofs[0].proofVersion).toBe(IMPORT_PROOF_VERSION);
    expect(proofs[0].lanes).toHaveLength(LEGACY_LANES.length);
  });

  it("reports a lane the manifest never inspected instead of passing it", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN],
      expectations: expectations({}, ["cost"]),
      items: [],
      runRefusals: [],
    });

    expect(proofs[0].holds).toBe(false);
    expect(proofs[0].refusals).toEqual(["cost:proof_lane_missing"]);
    // A lane with nothing behind it cannot borrow a fingerprint to stand on.
    expect(laneOf(proofs, "cost").fingerprint).toBe("");
  });

  it("keeps an item refusal on its own lane", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN],
      expectations: expectations({
        runtime_objects: { expectedItems: 1, totalBytes: 10 },
      }),
      items: [item({ refusal: "verify_hash_mismatch" })],
      runRefusals: [],
    });

    expect(proofs[0].refusals).toEqual(["runtime_objects:verify_hash_mismatch"]);
    expect(laneOf(proofs, "runtime_objects").verifiedItems).toBe(0);
    expect(laneOf(proofs, "transcript").refusals).toEqual([]);
  });

  it("refuses a count that fell short with no item to explain it", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN],
      expectations: expectations({
        transcript: { expectedItems: 2, totalBytes: 20 },
      }),
      items: [item({ lane: "transcript" })],
      runRefusals: [],
    });

    expect(proofs[0].refusals).toEqual(["transcript:verify_count_mismatch"]);
  });

  it("carries a run-level refusal on the lane it belongs to", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN],
      expectations: expectations(),
      items: [],
      runRefusals: [
        {
          runId: RUN,
          lane: "scratch_session",
          refusal: "verify_scratch_count_mismatch",
        },
      ],
    });

    expect(proofs[0].refusals).toEqual([
      "scratch_session:verify_scratch_count_mismatch",
    ]);
  });

  it("records the verified count and bytes as the durable position", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN],
      expectations: expectations({
        cost: { expectedItems: 2, totalBytes: 30 },
      }),
      items: [
        item({ itemId: "a", lane: "cost", sizeBytes: 10 }),
        item({ itemId: "b", lane: "cost", sizeBytes: 20 }),
      ],
      runRefusals: [],
    });

    expect(laneOf(proofs, "cost").position).toBe("items:2;bytes:30");
    expect(laneOf(proofs, "cost").verifiedBytes).toBe(30);
    expect(laneOf(proofs, "cost").expectedBytes).toBe(30);
  });

  it("proves each run separately", () => {
    const proofs = reduceRunProofs({
      runIds: [RUN, "run-2"],
      expectations: [
        ...expectations(),
        ...LEGACY_LANES.map((lane) => ({
          runId: "run-2",
          lane,
          manifestDigest: `d-${lane}`,
          expectedItems: 0,
          totalBytes: 0,
        })),
      ],
      items: [item({ refusal: "verify_bytes_missing" })],
      runRefusals: [],
    });

    expect(proofs[0].holds).toBe(false);
    expect(proofs[1].holds).toBe(true);
  });
});
