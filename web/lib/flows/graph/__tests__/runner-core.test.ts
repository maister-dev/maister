import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { loadRun } from "@/lib/flows/graph/runner-core";
import {
  flows as flowsTable,
  flowRevisions as flowRevisionsTable,
  projects as projectsTable,
  runSessions as runSessionsTable,
  runs as runsTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";

// M42 (ADR-114): loadRun projects `run_sessions` into `loaded.sessions` — the
// per-node dispatch's source for each session's host runner + resume handle.
describe("loadRun — per-session set (M42)", () => {
  function snapshot(id: string, model: string) {
    return {
      id,
      adapter: "claude",
      capabilityAgent: "claude",
      model,
      provider: { kind: "anthropic" },
      providerKind: "anthropic",
      permissionPolicy: "default",
      sidecarId: null,
    };
  }

  function fakeDb(
    runSessionRows: Record<string, unknown>[],
    opts?: { pinned?: boolean; mutableManifest?: unknown },
  ) {
    const run = {
      id: "run-1",
      taskId: "task-1",
      projectId: "project-1",
      flowId: "flow-1",
      flowRevisionId: opts?.pinned ? "revision-1" : null,
      flowRevision: opts?.pinned ? "rev-pinned" : "unknown",
      runnerSnapshot: snapshot("runner-default", "claude-opus-4-8"),
      capabilityAgent: "claude",
      runnerResolutionTier: "platformDefault",
      acpSessionId: "run-level-acp",
    };
    const byTable: Record<string, Record<string, unknown>[]> = {
      [getTableName(runsTable)]: [run],
      [getTableName(tasksTable)]: [{ id: "task-1" }],
      [getTableName(flowsTable)]: [
        {
          id: "flow-1",
          flowRefId: "bugfix",
          manifest: opts?.mutableManifest ?? {
            schemaVersion: 1,
            name: "Bugfix",
            nodes: [
              {
                id: "run",
                type: "cli",
                action: { command: "true" },
                transitions: { success: "done" },
              },
            ],
          },
        },
      ],
      [getTableName(flowRevisionsTable)]: [
        {
          id: "revision-1",
          manifest: {
            schemaVersion: 1,
            name: "Pinned",
            nodes: [
              {
                id: "pinned",
                type: "cli",
                action: { command: "true" },
                transitions: { success: "done" },
              },
            ],
          },
          installedPath: "/cache/pinned",
          execTrust: "trusted",
        },
      ],
      [getTableName(projectsTable)]: [{ slug: "demo" }],
      [getTableName(workspacesTable)]: [{ runId: "run-1", removedAt: null }],
      [getTableName(runSessionsTable)]: runSessionRows,
    };

    return {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => byTable[getTableName(table as never)] ?? [],
        }),
      }),
    };
  }

  it("maps each run_sessions row to a session with its runner + resume handle", async () => {
    const loaded = await loadRun(
      fakeDb([
        {
          sessionName: "default",
          runnerSnapshot: snapshot("runner-default", "claude-opus-4-8"),
          acpSessionId: "acp-default",
          capabilityAgent: "claude",
          runnerResolutionTier: "platformDefault",
        },
        {
          sessionName: "review",
          runnerSnapshot: snapshot("runner-review", "claude-sonnet-4-6"),
          acpSessionId: null,
          capabilityAgent: "claude",
          runnerResolutionTier: "binding",
        },
      ]) as never,
      "run-1",
    );

    expect(loaded.sessions.get("review")).toMatchObject({
      sessionName: "review",
      acpSessionId: null,
      runnerResolutionTier: "binding",
      runner: expect.objectContaining({ id: "runner-review" }),
    });
    expect(loaded.sessions.get("default")?.acpSessionId).toBe("acp-default");
  });

  it("fails loud when a run has no run_sessions rows (no runner source post-cutover)", async () => {
    // M42 (ADR-114): the run-level runner mirror is dropped, so a run that
    // carries no `run_sessions` row has no runner to resolve — loadRun throws
    // EXECUTOR_UNAVAILABLE rather than silently synthesizing a stale default.
    await expect(loadRun(fakeDb([]) as never, "run-1")).rejects.toThrow(
      /no ACP runner snapshot/,
    );
  });

  it("uses the pinned revision when the mutable flow cache is legacy", async () => {
    const loaded = await loadRun(
      fakeDb(
        [
          {
            sessionName: "default",
            runnerSnapshot: snapshot("runner-default", "claude-opus-4-8"),
            acpSessionId: null,
            capabilityAgent: "claude",
            runnerResolutionTier: "platformDefault",
          },
        ],
        {
          pinned: true,
          mutableManifest: {
            schemaVersion: 1,
            name: "Legacy cache",
            steps: [],
          },
        },
      ) as never,
      "run-1",
    );

    expect(loaded.manifest.nodes.map((node) => node.id)).toEqual(["pinned"]);
    expect(loaded.flowInstallPath).toBe("/cache/pinned");
    expect(loaded.execTrust).toBe("trusted");
  });
});
