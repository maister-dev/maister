import { describe, expect, it, vi } from "vitest";

const loadRunnerCatalog = vi.hoisted(() => vi.fn());
const loadFlowRunnerBindings = vi.hoisted(() => vi.fn());

vi.mock("@/lib/acp-runners/catalog", () => ({
  loadRunnerCatalog,
  loadFlowRunnerBindings,
}));

import {
  launchConsensusDraftRuns,
  type ConsensusDraftLaunchInput,
} from "@/lib/flows/graph/consensus/drafts";

function baseInput(db: unknown): ConsensusDraftLaunchInput {
  return {
    db,
    projectId: "project-1",
    taskId: "task-1",
    parentRunId: "parent-run",
    rootRunId: "root-run",
    nodeId: "decide",
    nodeAttemptId: "attempt-1",
    round: 1,
    prompt: "Settle the release plan.",
    participants: [
      { id: "architect", agent: "pkg:architect" },
      { id: "codex", runner: "runner-codex" },
    ],
    workspaceMode: "repo_read",
  } as ConsensusDraftLaunchInput;
}

function fakeDb(args: {
  existingRows?: unknown[][];
  runnerRows?: unknown[];
  inserts?: unknown[];
}): unknown {
  let selectCall = 0;

  return {
    select: () => ({
      from: () => ({
        where: () => {
          const existing = args.existingRows?.[selectCall];

          selectCall += 1;

          return existing ?? args.runnerRows ?? [];
        },
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        args.inserts?.push(row);

        return Promise.resolve();
      },
    }),
  };
}

describe("launchConsensusDraftRuns", () => {
  it("launches agent participants through launchAgentRun and runner participants without catalog agent rows", async () => {
    const inserts: unknown[] = [];
    const db = fakeDb({
      existingRows: [[], []],
      runnerRows: [
        {
          id: "runner-codex",
          adapter: "codex",
          capabilityAgent: "codex",
          model: "gpt-5-codex",
          provider: { kind: "openai" },
          permissionPolicy: "default",
          readinessStatus: "Ready",
          enabled: true,
        },
      ],
      inserts,
    });

    loadRunnerCatalog.mockResolvedValue([
      {
        id: "runner-codex",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "gpt-5-codex",
        providerKind: "openai",
        permissionPolicy: "default",
        enabled: true,
        ready: true,
      },
    ]);
    loadFlowRunnerBindings.mockResolvedValue([]);

    const launchAgent = vi.fn(async () => ({
      runId: "agent-child",
      status: "Pending" as const,
    }));
    const tryStartRun = vi.fn(async () => ({ started: true as const }));
    const startAgentSession = vi.fn(async () => undefined);

    const result = await launchConsensusDraftRuns(baseInput(db), {
      launchAgent,
      startAgentSession,
      tryStartRun,
    });

    expect(launchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "pkg:architect",
        parentRunId: "parent-run",
        rootRunId: "root-run",
        workspace: "repo_read",
        trigger: {
          source: "flow",
          payload: expect.objectContaining({
            kind: "consensus_draft",
            participantId: "architect",
            participantKind: "agent",
            prompt: "Settle the release plan.",
          }),
        },
      }),
    );
    expect(result).toEqual([
      {
        participantId: "architect",
        participantKind: "agent",
        runId: "agent-child",
        status: "Pending",
      },
      {
        participantId: "codex",
        participantKind: "runner",
        runId: expect.any(String),
        status: "Running",
      },
    ]);
    // M42 (ADR-114): the consensus child run + its single `default` run_sessions row.
    expect(inserts).toHaveLength(2);
    expect(inserts[1]).toMatchObject({
      runId: expect.any(String),
      sessionName: "default",
      runnerId: "runner-codex",
    });
    expect(inserts[0]).toMatchObject({
      runKind: "agent",
      agentId: null,
      status: "Pending",
      parentRunId: "parent-run",
      rootRunId: "root-run",
      triggerPayload: expect.objectContaining({
        kind: "consensus_draft",
        participantId: "codex",
        participantKind: "runner",
      }),
      delegationSnapshot: expect.objectContaining({
        kind: "runner",
        runnerId: "runner-codex",
        participantId: "codex",
        nodeAttemptId: "attempt-1",
      }),
    });
    expect(tryStartRun).toHaveBeenCalledWith(expect.any(String), { db });
  });

  it("does not relaunch an already recorded participant draft", async () => {
    const db = fakeDb({
      existingRows: [
        [
          {
            id: "existing-child",
            status: "Running",
            triggerPayload: {
              kind: "consensus_draft",
              participantKind: "agent",
            },
          },
        ],
      ],
    });
    const input = {
      ...baseInput(db),
      participants: [{ id: "architect", agent: "pkg:architect" }],
    } as ConsensusDraftLaunchInput;
    const launchAgent = vi.fn();

    const result = await launchConsensusDraftRuns(input, { launchAgent });

    expect(launchAgent).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        participantId: "architect",
        participantKind: "agent",
        runId: "existing-child",
        status: "Running",
      },
    ]);
  });
});
