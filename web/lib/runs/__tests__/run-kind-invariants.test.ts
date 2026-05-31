import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  assertRunKindInvariant,
  assertRunScratchMetadataInvariant,
} from "@/lib/runs/run-kind-invariants";

describe("assertRunKindInvariant", () => {
  it("accepts flow runs with task and flow links", () => {
    expect(() =>
      assertRunKindInvariant({
        runKind: "flow",
        taskId: "task-1",
        flowId: "flow-1",
        flowRevisionId: "rev-1",
        flowVersion: "v1.0.0",
        flowRevision: "abc123",
      }),
    ).not.toThrow();
  });

  it("rejects flow runs without task and flow links", () => {
    expect(() =>
      assertRunKindInvariant({
        runKind: "flow",
        taskId: null,
        flowId: null,
        flowRevisionId: null,
        flowVersion: "v1.0.0",
        flowRevision: "abc123",
      }),
    ).toThrow(MaisterError);
  });

  it("accepts scratch runs with scratch sentinels and no hidden task links", () => {
    expect(() =>
      assertRunKindInvariant({
        runKind: "scratch",
        taskId: null,
        flowId: null,
        flowRevisionId: null,
        flowVersion: "scratch",
        flowRevision: "manual",
      }),
    ).not.toThrow();
  });

  it("rejects scratch runs with hidden task or Flow links", () => {
    expect(() =>
      assertRunKindInvariant({
        runKind: "scratch",
        taskId: "task-1",
        flowId: null,
        flowRevisionId: null,
        flowVersion: "scratch",
        flowRevision: "manual",
      }),
    ).toThrow(MaisterError);
  });

  it("rejects scratch runs without scratch sentinels", () => {
    expect(() =>
      assertRunKindInvariant({
        runKind: "scratch",
        taskId: null,
        flowId: null,
        flowRevisionId: null,
        flowVersion: "v1.0.0",
        flowRevision: "abc123",
      }),
    ).toThrow(MaisterError);
  });

  it("requires scratch metadata for scratch runs", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
      }),
    ).not.toThrow();

    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: null,
      }),
    ).toThrow(MaisterError);
  });

  it("rejects scratch metadata for flow runs", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "flow",
        scratchRunId: "run-1",
      }),
    ).toThrow(MaisterError);
  });
});
