import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  assertRunKindInvariant,
  assertRunScratchMetadataInvariant,
  requireRunProjectId,
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

  // M36 Phase 5 (ADR-096): the project / local-package XOR.
  it("admits a project scratch run (projectId set, no local package)", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
        projectId: "proj-1",
        localPackageId: null,
      }),
    ).not.toThrow();
  });

  it("admits a project-less local-package scratch run (localPackageId set)", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
        projectId: null,
        localPackageId: "lp-1",
      }),
    ).not.toThrow();
  });

  it("rejects a scratch run with BOTH project and local package set", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
        projectId: "proj-1",
        localPackageId: "lp-1",
      }),
    ).toThrow(MaisterError);
  });

  it("rejects a scratch run with NEITHER project nor local package set", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
        projectId: null,
        localPackageId: null,
      }),
    ).toThrow(MaisterError);
  });

  it("rejects a non-scratch run that carries a localPackageId", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "flow",
        scratchRunId: null,
        localPackageId: "lp-1",
      }),
    ).toThrow(MaisterError);
  });

  it("still admits legacy scratch calls that omit the owner pair", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
      }),
    ).not.toThrow();
  });
});

describe("requireRunProjectId", () => {
  it("returns the project id when present", () => {
    expect(requireRunProjectId("proj-1", "run-1")).toBe("proj-1");
  });

  it("throws CONFIG when the project id is null (project-less run)", () => {
    expect(() => requireRunProjectId(null, "run-1")).toThrow(MaisterError);
  });
});
