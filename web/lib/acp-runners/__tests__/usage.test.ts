import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";

import {
  collectRunnerUsageReferences,
  collectSidecarUsageReferences,
  loadRunnerUsageReferences,
} from "@/lib/acp-runners/usage";

describe("ACP runner usage references", () => {
  it("collects every runner reference class used by guards and usage panels", () => {
    const refs = collectRunnerUsageReferences({
      runnerId: "runner-a",
      platformDefaultRunnerId: "runner-a",
      projectDefaults: [
        { projectId: "project-1", runnerId: "runner-a" },
        { projectId: "project-2", runnerId: "runner-b" },
      ],
      platformFlowDefaults: [
        {
          flowRevisionId: "flow-rev-1",
          flowRefId: "bugfix",
          runnerId: "runner-a",
        },
      ],
      projectFlowDefaults: [
        { projectId: "project-1", flowId: "flow-1", runnerId: "runner-a" },
      ],
      flowStepRemaps: [
        {
          projectId: "project-1",
          flowRevisionId: "flow-rev-1",
          slotKey: "session:default",
          mappedRunnerId: "runner-a",
        },
      ],
      activeRuns: [
        { runId: "run-active", projectId: "project-1", runnerId: "runner-a" },
      ],
      historicalRunSnapshots: [
        {
          runId: "run-history",
          projectId: "project-1",
          runnerSnapshot: { id: "runner-a" },
        },
      ],
      scratchRuns: [
        { runId: "scratch-1", projectId: "project-1", runnerId: "runner-a" },
      ],
    });

    expect(refs.map((ref) => ref.kind)).toEqual([
      "platformDefault",
      "projectDefault",
      "platformFlowDefault",
      "projectFlowDefault",
      "flowStepRemap",
      "activeRun",
      "historicalRunSnapshot",
      "scratchRun",
    ]);
  });

  it("collects sidecar references through runners", () => {
    const refs = collectSidecarUsageReferences({
      sidecarId: "ccr-default",
      runners: [
        { runnerId: "runner-a", sidecarId: "ccr-default" },
        { runnerId: "runner-b", sidecarId: null },
      ],
    });

    expect(refs).toEqual([
      {
        kind: "runnerSidecar",
        runnerId: "runner-a",
        sidecarId: "ccr-default",
      },
    ]);
  });

  it("loads runner references from the DB snapshot used by mutation guards", async () => {
    const tables: Record<string, Record<string, unknown>[]> = {
      flow_revisions: [
        {
          id: "flow-rev-1",
          flowRefId: "bugfix",
          defaultRunnerId: "runner-a",
        },
      ],
      flow_runner_remaps: [
        {
          projectId: "project-1",
          flowRevisionId: "flow-rev-1",
          slotKey: "session:default",
          mappedRunnerId: "runner-a",
        },
      ],
      platform_runtime_settings: [
        { id: "singleton", defaultRunnerId: "runner-a" },
      ],
      project_flow_runner_defaults: [
        { projectId: "project-1", flowId: "flow-1", runnerId: "runner-a" },
      ],
      projects: [{ id: "project-1", defaultRunnerId: "runner-a" }],
      runs: [
        {
          id: "run-active",
          projectId: "project-1",
          runKind: "flow",
          status: "Running",
          runnerId: "runner-a",
          runnerSnapshot: { id: "runner-a" },
        },
        {
          id: "scratch-1",
          projectId: "project-1",
          runKind: "scratch",
          status: "Done",
          runnerId: "runner-a",
          runnerSnapshot: null,
        },
      ],
    };
    const db = {
      select: () => ({
        from: (table: unknown) => tables[getTableName(table as never)] ?? [],
      }),
    };

    const refs = await loadRunnerUsageReferences(
      db as Parameters<typeof loadRunnerUsageReferences>[0],
      "runner-a",
    );

    expect(refs.map((ref) => ref.kind)).toEqual([
      "platformDefault",
      "projectDefault",
      "platformFlowDefault",
      "projectFlowDefault",
      "flowStepRemap",
      "activeRun",
      "historicalRunSnapshot",
      "scratchRun",
    ]);
  });
});
