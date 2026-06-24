import type { ConsensusNodeDef } from "@/lib/flows/graph/consensus/drafts";
import type {
  ConsensusDraftEvidence,
  ConsensusVerdictEvidence,
} from "@/lib/flows/graph/consensus/ledger";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConsensusNode } from "@/lib/flows/graph/consensus/runtime";

const launchConsensusDraftRuns = vi.hoisted(() => vi.fn());
const latestConsensusRound = vi.hoisted(() => vi.fn());
const loadConsensusDraftEvidence = vi.hoisted(() => vi.fn());
const loadConsensusVerdicts = vi.hoisted(() => vi.fn());
const recordConsensusVerdict = vi.hoisted(() => vi.fn());
const runAgentStep = vi.hoisted(() => vi.fn());
const recordCurrentArtifact = vi.hoisted(() => vi.fn());
const atomicWriteJson = vi.hoisted(() => vi.fn());
const createHitlAssignmentForRun = vi.hoisted(() => vi.fn());
const emitWebhookEvent = vi.hoisted(() => vi.fn());
const releaseCapacity = vi.hoisted(() => vi.fn());
const acquireConsensusAgentCapacity = vi.hoisted(() => vi.fn());

vi.mock("@/lib/flows/graph/consensus/drafts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/flows/graph/consensus/drafts")>();

  return { ...actual, launchConsensusDraftRuns };
});

vi.mock("@/lib/flows/graph/consensus/ledger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/flows/graph/consensus/ledger")>();

  return {
    ...actual,
    latestConsensusRound,
    loadConsensusDraftEvidence,
    loadConsensusVerdicts,
    recordConsensusVerdict,
  };
});

vi.mock("@/lib/flows/runner-agent", () => ({ runAgentStep }));
vi.mock("@/lib/flows/graph/artifact-store", () => ({ recordCurrentArtifact }));
vi.mock("@/lib/atomic", () => ({ atomicWriteJson }));
vi.mock("@/lib/assignments/service", () => ({ createHitlAssignmentForRun }));
vi.mock("@/lib/webhooks/outbox", () => ({ emitWebhookEvent }));
vi.mock("@/lib/flows/graph/consensus/capacity", () => ({
  acquireConsensusAgentCapacity,
}));

function consensusDef(): ConsensusNodeDef {
  return {
    id: "decide",
    type: "consensus",
    prompt: "Pick a release plan.",
    participants: [
      { id: "architect", runner: "claude" },
      { id: "qa", runner: "codex" },
    ],
    workspace: { mode: "repo_read" },
    material_axes: ["scope", "risk"],
    rounds: { mode: "single_pass", max: 1 },
    on_no_consensus: "escalate",
    synthesizer: { runner: "claude" },
    output: {
      produces: [
        { id: "consensus_plan", kind: "plan", current: true },
        { id: "debate_log", kind: "human_note", current: true },
      ],
    },
    transitions: { on_success: "done" },
  } as ConsensusNodeDef;
}

function draft(participantId: string, text: string): ConsensusDraftEvidence {
  return {
    participantId,
    participantKind: "runner",
    runId: `child-${participantId}`,
    round: 1,
    status: "Done",
    artifactId: `artifact-${participantId}`,
    artifactText: text,
  };
}

function verdict(
  verifierId: string,
  targetParticipantId: string,
  overrides: Partial<ConsensusVerdictEvidence> = {},
): ConsensusVerdictEvidence {
  return {
    verifierId,
    targetParticipantId,
    round: 1,
    parseStatus: "parsed",
    verdict: "agree",
    axes: { scope: true, risk: true },
    disagreements: [],
    rawOutputArtifactId: `verdict-${verifierId}-${targetParticipantId}`,
    ...overrides,
  };
}

function db(): unknown {
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "claude",
            adapter: "claude",
            capabilityAgent: "claude",
            model: "sonnet",
            provider: { kind: "anthropic" },
            permissionPolicy: "default",
            enabled: true,
            readinessStatus: "Ready",
          },
        ]),
      })),
    })),
  };
}

function runnerRow(
  id: string,
  capabilityAgent: string,
): Record<string, unknown> {
  return {
    id,
    adapter: capabilityAgent,
    capabilityAgent,
    model: `${capabilityAgent}-model`,
    provider:
      capabilityAgent === "claude" ? { kind: "anthropic" } : { kind: "openai" },
    permissionPolicy: "default",
    enabled: true,
    readinessStatus: "Ready",
  };
}

function dbWithRunnerRows(rows: Record<string, unknown>[]): unknown {
  const tx = {
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };
  const queue = [...rows];

  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          const row = queue.shift();

          return row ? [row] : [];
        }),
      })),
    })),
  };
}

async function runtimeInputFile(decision: Record<string, unknown>): Promise<{
  runtimeRoot: string;
  inputPath: string;
  cleanup: () => Promise<void>;
}> {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "consensus-runtime-"));
  const dir = path.join(runtimeRoot, ".maister", "project", "runs", "run-1");
  const inputPath = path.join(dir, "input-decide.json");

  await mkdir(dir, { recursive: true });
  await writeFile(inputPath, JSON.stringify(decision), "utf8");

  return {
    runtimeRoot,
    inputPath,
    cleanup: () => rm(runtimeRoot, { recursive: true, force: true }),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const def = consensusDef();

  return {
    node: { id: "decide", nodeType: "consensus" },
    def,
    loaded: {
      run: {
        id: "run-1",
        projectId: "project-1",
        taskId: "task-1",
        rootRunId: "run-1",
      },
      executor: {
        id: "runner-parent",
        agent: "claude",
        model: "sonnet",
        env: null,
        router: null,
      },
      projectSlug: "project",
    },
    context: {
      task: { id: "task-1", title: "Task", prompt: "Prompt", attemptNumber: 1 },
      run: { id: "run-1", attemptNumber: 1, projectSlug: "project" },
      executor: { id: "runner-parent", agent: "claude", model: "sonnet" },
      steps: {},
      env: {},
      artifacts: {},
    },
    runtimeRoot: "/tmp/runtime",
    worktreePath: "/tmp/repo",
    sessionState: { currentSessionId: null, lastSeenMonotonicId: 0 },
    nodeAttemptId: "attempt-1",
    nodeAttemptNumber: 1,
    db: db(),
    ...overrides,
  } as Parameters<typeof runConsensusNode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  acquireConsensusAgentCapacity.mockResolvedValue(releaseCapacity);
  loadConsensusVerdicts.mockResolvedValue([]);
  atomicWriteJson.mockResolvedValue(undefined);
  createHitlAssignmentForRun.mockResolvedValue(undefined);
  emitWebhookEvent.mockResolvedValue(undefined);
  recordCurrentArtifact.mockResolvedValue({ id: "artifact" });
});

describe("runConsensusNode", () => {
  it("fans out the first round and parks on child drafts", async () => {
    latestConsensusRound.mockResolvedValue(0);
    loadConsensusDraftEvidence.mockResolvedValue([]);
    launchConsensusDraftRuns.mockResolvedValue([
      { participantId: "architect", runId: "child-1", status: "Running" },
      { participantId: "qa", runId: "child-2", status: "Pending" },
    ]);

    const result = await runConsensusNode(input());

    expect(result.needsInput).toBe(true);
    expect(result.waitsForChildren).toBe(true);
    expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
      expect.objectContaining({ round: 1, nodeAttemptId: "attempt-1" }),
    );
  });

  it("escalates no consensus as a human HITL pause", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"disagree","axes":{"scope":false,"risk":true},"disagreements":[{"axis":"scope","claim":"scope mismatch","counter_evidence":"drafts differ"}]}',
      vars: {},
    });
    recordConsensusVerdict.mockImplementation(async (args) => ({
      verifierId: args.verifierId,
      targetParticipantId: args.targetParticipantId,
      round: args.round,
      parseStatus: "parsed",
      verdict: "disagree",
      axes: { scope: false, risk: true },
      disagreements: [
        {
          axis: "scope",
          claim: "scope mismatch",
          counterEvidence: "drafts differ",
        },
      ],
      rawOutputArtifactId: "verdict-artifact",
    }));

    const result = await runConsensusNode(input());

    expect(result.needsInput).toBe(true);
    expect(result.waitsForChildren).toBe(false);
    expect(atomicWriteJson).toHaveBeenCalledWith(
      "/tmp/runtime/.maister/project/runs/run-1/needs-input.json",
      expect.objectContaining({
        kind: "consensus_resolution",
        schema: expect.objectContaining({
          kind: "consensus_resolution",
          allowedDecisions: expect.arrayContaining([
            "pick-draft-1",
            "provide-resolution",
            "abort",
          ]),
        }),
      }),
    );
  });

  it("runs each verifier on that verifier participant runner", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"disagree","axes":{"scope":false,"risk":true},"disagreements":[{"axis":"scope","claim":"scope mismatch","counter_evidence":"drafts differ"}]}',
      vars: {},
    });
    recordConsensusVerdict.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        parseStatus: args.result.parseStatus,
        verdict: args.result.verdict,
        axes: args.result.axes,
        disagreements: args.result.disagreements,
      }),
    );

    await runConsensusNode(
      input({
        db: dbWithRunnerRows([
          runnerRow("claude", "claude"),
          runnerRow("codex", "codex"),
        ]),
      }),
    );

    expect(runAgentStep.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        executor: expect.objectContaining({
          id: "claude",
          agent: "claude",
        }),
        runner: expect.objectContaining({ runnerId: "claude" }),
      }),
    );
    expect(runAgentStep.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        executor: expect.objectContaining({
          id: "codex",
          agent: "codex",
        }),
        runner: expect.objectContaining({ runnerId: "codex" }),
      }),
    );
  });

  it("synthesizes mandatory artifacts after unanimous verdicts", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan A"),
    ]);
    runAgentStep
      .mockResolvedValueOnce({
        ok: true,
        stdout:
          '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
        vars: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout:
          '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
        vars: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "Final consensus plan",
        vars: {},
      });
    recordConsensusVerdict.mockImplementation(async (args) => ({
      verifierId: args.verifierId,
      targetParticipantId: args.targetParticipantId,
      round: args.round,
      parseStatus: "parsed",
      verdict: "agree",
      axes: { scope: true, risk: true },
      disagreements: [],
      rawOutputArtifactId: "verdict-artifact",
    }));

    const result = await runConsensusNode(input());

    expect(result.ok).toBe(true);
    expect(runAgentStep.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        executor: expect.objectContaining({ id: "claude" }),
        runner: expect.objectContaining({ runnerId: "claude" }),
      }),
    );
    expect(recordCurrentArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactDefId: "consensus_plan",
        kind: "plan",
        locator: { kind: "inline", text: "Final consensus plan" },
      }),
      expect.anything(),
    );
    expect(recordCurrentArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactDefId: "debate_log",
        kind: "human_note",
      }),
      expect.anything(),
    );
  });

  it("reuses persisted verifier rows on resume without charging duplicate verification", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan A"),
    ]);
    loadConsensusVerdicts.mockResolvedValue([
      verdict("architect", "qa"),
      verdict("qa", "architect"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout: "Final cached-verdict plan",
      vars: {},
    });

    const result = await runConsensusNode(input());

    expect(result.ok).toBe(true);
    expect(recordConsensusVerdict).not.toHaveBeenCalled();
    expect(runAgentStep).toHaveBeenCalledTimes(1);
    expect(runAgentStep.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: "decide:synthesize" }),
    );
  });

  it("fails closed and releases capacity when verifier execution throws", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockRejectedValueOnce(new Error("spawn failed"));
    recordConsensusVerdict.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        parseStatus: args.result.parseStatus,
        verdict: args.result.verdict,
        axes: args.result.axes,
        disagreements: args.result.disagreements,
        errorCode: args.errorCode,
      }),
    );

    const result = await runConsensusNode(input());

    expect(result.needsInput).toBe(true);
    expect(releaseCapacity).toHaveBeenCalledTimes(2);
    expect(recordConsensusVerdict).toHaveBeenCalledWith(
      expect.objectContaining({
        verifierId: "architect",
        targetParticipantId: "qa",
        errorCode: "Error",
        result: expect.objectContaining({
          parseStatus: "invalid_json",
          verdict: "disagree",
        }),
      }),
    );
  });

  it("re-fans an iterate round with bounded disagreement critique", async () => {
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 2 },
    } as ConsensusNodeDef;

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"disagree","axes":{"scope":false,"risk":true},"disagreements":[{"axis":"scope","claim":"scope mismatch","counter_evidence":"drafts differ"}]}',
      vars: {},
    });
    recordConsensusVerdict.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        parseStatus: args.result.parseStatus,
        verdict: args.result.verdict,
        axes: args.result.axes,
        disagreements: args.result.disagreements,
      }),
    );

    const result = await runConsensusNode(input({ def }));

    expect(result.needsInput).toBe(true);
    expect(result.waitsForChildren).toBe(true);
    expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 2,
        prompt: expect.stringContaining("Prior-round critique"),
      }),
    );
  });

  it("does not report success when the mandatory debate artifact write fails", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan A"),
    ]);
    runAgentStep
      .mockResolvedValueOnce({
        ok: true,
        stdout:
          '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
        vars: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout:
          '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
        vars: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        stdout: "Final consensus plan",
        vars: {},
      });
    recordConsensusVerdict.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        parseStatus: args.result.parseStatus,
        verdict: args.result.verdict,
        axes: args.result.axes,
        disagreements: args.result.disagreements,
      }),
    );
    recordCurrentArtifact
      .mockResolvedValueOnce({ id: "consensus_plan" })
      .mockRejectedValueOnce(new Error("artifact write failed"));

    await expect(runConsensusNode(input())).rejects.toThrow(
      "artifact write failed",
    );
  });

  it("retains human input when human synthesis artifact writes fail", async () => {
    const files = await runtimeInputFile({
      decision: "provide-resolution",
      resolution: "Use the manually reconciled plan.",
    });

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout: "Final manual consensus plan",
      vars: {},
    });
    recordCurrentArtifact
      .mockResolvedValueOnce({ id: "consensus_plan" })
      .mockRejectedValueOnce(new Error("artifact write failed"));

    try {
      await expect(
        runConsensusNode(input({ runtimeRoot: files.runtimeRoot })),
      ).rejects.toThrow("artifact write failed");
      await expect(readFile(files.inputPath, "utf8")).resolves.toContain(
        "provide-resolution",
      );
    } finally {
      await files.cleanup();
    }
  });

  it("removes human input after human synthesis artifacts succeed", async () => {
    const files = await runtimeInputFile({
      decision: "provide-resolution",
      resolution: "Use the manually reconciled plan.",
    });

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout: "Final manual consensus plan",
      vars: {},
    });

    try {
      const result = await runConsensusNode(
        input({ runtimeRoot: files.runtimeRoot }),
      );

      expect(result.ok).toBe(true);
      await expect(readFile(files.inputPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await files.cleanup();
    }
  });
});
