// S4.2 / D9 "Inventory and deterministic mapping": every file under a legacy run
// directory is classified into exactly one preservation lane with an explicit
// disposition. An ordinary `<step>.log` is valid history, not a refusal (R11 /
// AB-11), and an unrecognized source blocks its lane instead of passing through
// a blanket allowlist.

import { describe, expect, it } from "vitest";

import {
  LEGACY_MANIFEST_VERSION,
  classifyLegacySource,
  laneManifestDigest,
  manifestItemId,
} from "../sources";

const identity = {
  manifestVersion: LEGACY_MANIFEST_VERSION,
  frozenSourceId: "import-7f3a",
  runId: "run-1",
  associationKey: "source",
  relativePathDigest: "a".repeat(64),
  size: 12,
  sha256: "b".repeat(64),
};

describe("classifyLegacySource", () => {
  it("preserves an ordinary step log instead of refusing the run", () => {
    expect(classifyLegacySource("plan.log")).toEqual({
      sourceClass: "step_log",
      lane: "runtime_objects",
      disposition: "copy",
    });
  });

  it("preserves a nested raw log discovered below the run root", () => {
    expect(classifyLegacySource("steps/plan/attempt-2.log")).toEqual({
      sourceClass: "step_log",
      lane: "runtime_objects",
      disposition: "copy",
    });
  });

  it("classifies a scratch upload with its scope and file name", () => {
    expect(classifyLegacySource("uploads/msg-42/report.pdf")).toEqual({
      sourceClass: "upload",
      lane: "scratch_session",
      disposition: "copy",
      scope: "msg-42",
      fileName: "report.pdf",
    });
  });

  it("copies the raw event and cost files into their own byte lanes", () => {
    expect(classifyLegacySource("run.events.jsonl")).toEqual({
      sourceClass: "raw_transcript",
      lane: "transcript",
      disposition: "copy",
    });
    expect(classifyLegacySource("cost.jsonl")).toEqual({
      sourceClass: "cost_diagnostic",
      lane: "cost",
      disposition: "copy",
    });
  });

  it("accounts for manager-authored control files without moving them to host objects", () => {
    for (const relativePath of [
      "run.json",
      "needs-input.json",
      "input-review.json",
      "node-start-plan.json",
      "output-plan.json",
      "flow-assistant-actions.jsonl",
    ]) {
      expect(classifyLegacySource(relativePath)).toEqual({
        sourceClass: "manager_owned",
        lane: "events",
        disposition: "manager_authoritative",
      });
    }
  });

  it("preserves session and checkpoint metadata when it is discovered", () => {
    expect(classifyLegacySource("session.json")).toEqual({
      sourceClass: "session_metadata",
      lane: "scratch_session",
      disposition: "copy",
    });
    expect(classifyLegacySource("checkpoint-3.json")).toEqual({
      sourceClass: "session_metadata",
      lane: "scratch_session",
      disposition: "copy",
    });
  });

  it("blocks an unrecognized source rather than admitting it through an allowlist", () => {
    expect(classifyLegacySource("mystery.bin")).toEqual({
      sourceClass: "unclassified",
      lane: null,
      disposition: "blocked",
      reason: "unclassified_source",
    });
  });

  it("blocks an upload that does not carry exactly one scope segment", () => {
    expect(classifyLegacySource("uploads/report.pdf")).toMatchObject({
      sourceClass: "unclassified",
      disposition: "blocked",
    });
    expect(classifyLegacySource("uploads/msg-42/nested/report.pdf")).toMatchObject({
      sourceClass: "unclassified",
      disposition: "blocked",
    });
  });

  it("does not admit a manager-owned name found below the run root", () => {
    expect(classifyLegacySource("nested/run.json")).toMatchObject({
      sourceClass: "unclassified",
      disposition: "blocked",
    });
  });
});

describe("manifestItemId", () => {
  it("is stable for one identity", () => {
    expect(manifestItemId(identity)).toBe(manifestItemId({ ...identity }));
    expect(manifestItemId(identity)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any identity component changes", () => {
    const base = manifestItemId(identity);
    const variants = [
      { ...identity, frozenSourceId: "import-0000" },
      { ...identity, runId: "run-2" },
      { ...identity, associationKey: "artifact:art-1" },
      { ...identity, relativePathDigest: "c".repeat(64) },
      { ...identity, size: 13 },
      { ...identity, sha256: "d".repeat(64) },
    ];

    for (const variant of variants) {
      expect(manifestItemId(variant)).not.toBe(base);
    }
  });

  it("keeps duplicate references to one file distinct while their bytes stay equal", () => {
    const first = manifestItemId({ ...identity, associationKey: "artifact:art-1" });
    const second = manifestItemId({ ...identity, associationKey: "artifact:art-2" });

    expect(first).not.toBe(second);
  });
});

describe("laneManifestDigest", () => {
  const scope = "e".repeat(64);
  const items = [
    { itemId: "1".repeat(64), size: 4, sha256: "2".repeat(64) },
    { itemId: "3".repeat(64), size: 7, sha256: "4".repeat(64) },
  ];

  it("is independent of the order the items were discovered in", () => {
    expect(
      laneManifestDigest({ lane: "runtime_objects", inspectedScope: scope, items }),
    ).toBe(
      laneManifestDigest({
        lane: "runtime_objects",
        inspectedScope: scope,
        items: [...items].reverse(),
      }),
    );
  });

  it("changes when an item's bytes change", () => {
    expect(
      laneManifestDigest({ lane: "runtime_objects", inspectedScope: scope, items }),
    ).not.toBe(
      laneManifestDigest({
        lane: "runtime_objects",
        inspectedScope: scope,
        items: [items[0], { ...items[1], sha256: "5".repeat(64) }],
      }),
    );
  });

  it("separates lanes that hold the identical item set", () => {
    expect(
      laneManifestDigest({ lane: "runtime_objects", inspectedScope: scope, items }),
    ).not.toBe(
      laneManifestDigest({ lane: "scratch_session", inspectedScope: scope, items }),
    );
  });

  it("proves an empty lane against the scope that was inspected, never a blanket zero", () => {
    const inspected = laneManifestDigest({
      lane: "scratch_session",
      inspectedScope: scope,
      items: [],
    });
    const elsewhere = laneManifestDigest({
      lane: "scratch_session",
      inspectedScope: "f".repeat(64),
      items: [],
    });

    expect(inspected).not.toBe(elsewhere);
  });
});
