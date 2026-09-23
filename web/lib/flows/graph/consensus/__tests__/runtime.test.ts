import type { ConsensusNodeDef } from "@/lib/flows/graph/consensus/drafts";
import type {
  ConsensusDraftEvidence,
  ConsensusVerdictEvidence,
} from "@/lib/flows/graph/consensus/ledger";

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runConsensusNode,
  synthesisPrompt,
  verifierPrompt,
  withConsensusVars,
} from "@/lib/flows/graph/consensus/runtime";
import { renderStrict } from "@/lib/flows/templating";

const launchConsensusDraftRuns = vi.hoisted(() => vi.fn());
const latestConsensusRound = vi.hoisted(() => vi.fn());
const loadConsensusDraftEvidence = vi.hoisted(() => vi.fn());
const loadConsensusDraftFailureReasons = vi.hoisted(() => vi.fn());
const loadConsensusVerdicts = vi.hoisted(() => vi.fn());
const recordConsensusVerdict = vi.hoisted(() => vi.fn());
const loadConsensusVerdictCell = vi.hoisted(() => vi.fn());
const loadConsensusSynthesis = vi.hoisted(() => vi.fn());
const closeAppliedConsensusSession = vi.hoisted(() => vi.fn());
const runAgentStep = vi.hoisted(() => vi.fn());
const recordCurrentArtifact = vi.hoisted(() => vi.fn());
const prepareConsensusInputEvidence = vi.hoisted(() => vi.fn());
const resolveConsensusHumanRequest = vi.hoisted(() => vi.fn());
const prepareConsensusHumanIntent = vi.hoisted(() => vi.fn());
const isConsensusHumanIntentApplied = vi.hoisted(() => vi.fn());
const markConsensusHumanIntentApplied = vi.hoisted(() => vi.fn());
const atomicWriteJson = vi.hoisted(() => vi.fn());
const createHitlAssignmentForRun = vi.hoisted(() => vi.fn());
const emitWebhookEvent = vi.hoisted(() => vi.fn());
const releaseCapacity = vi.hoisted(() => vi.fn());
const acquireConsensusAgentCapacity = vi.hoisted(() => vi.fn());
const loadRunnerCatalog = vi.hoisted(() => vi.fn());
const loadFlowRunnerBindings = vi.hoisted(() => vi.fn());
const loadProjectPlatformRunnerDefaults = vi.hoisted(() => vi.fn());

vi.mock("@/lib/acp-runners/catalog", () => ({
  loadRunnerCatalog,
  loadFlowRunnerBindings,
  loadProjectPlatformRunnerDefaults,
}));

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
    loadConsensusDraftFailureReasons,
    loadConsensusVerdictCell,
    loadConsensusVerdicts,
    recordConsensusVerdict,
  };
});

vi.mock("@/lib/flows/graph/consensus/prompt-owner", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/flows/graph/consensus/prompt-owner")
    >();

  return { ...actual, loadConsensusSynthesis, closeAppliedConsensusSession };
});

vi.mock("@/lib/flows/runner-agent", () => ({ runAgentStep }));
vi.mock("@/lib/flows/graph/artifact-store", () => ({ recordCurrentArtifact }));
vi.mock("@/lib/flows/graph/consensus/input-evidence", () => ({
  prepareConsensusInputEvidence,
}));
vi.mock("@/lib/flows/graph/consensus/human-decision", () => ({
  resolveConsensusHumanRequest,
  prepareConsensusHumanIntent,
  isConsensusHumanIntentApplied,
  markConsensusHumanIntentApplied,
}));
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
    classification: "complete",
    stopReason: "end_turn",
    reason: null,
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

function synthesis(text: string) {
  return {
    kind: "complete" as const,
    synthesisId: "run:attempt-1:consensus-synthesis:r1:consensus",
    text,
  };
}

// `ensureSubstepRunSession` seeds a substep's `run_sessions` row on the
// top-level handle before the create ack, so the stub must model the real
// chain: insert().values().onConflictDoNothing(). Values are recorded so a
// test can assert WHICH runner the substep's row records.
const runSessionInserts: Record<string, unknown>[] = [];

function runSessionInsertStub() {
  return vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => {
      runSessionInserts.push(values);

      return { onConflictDoNothing: vi.fn(async () => undefined) };
    }),
  }));
}

function db(): unknown {
  let artifactLocator: unknown;
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((value: { locator?: unknown }) => {
        if (value.locator) artifactLocator = value.locator;

        return { onConflictDoNothing: vi.fn(async () => undefined) };
      }),
    })),
    // A real transaction can read. `createHitlRequest` — the one writer of
    // hitl_requests — reads the run back to resolve the project the
    // `run.needs_input` event belongs to, so a tx stub with only `insert`
    // models a transaction that does not exist.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            projectId: "project-1",
            taskId: "task-1",
            locator: artifactLocator,
          },
        ]),
      })),
    })),
  };

  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    insert: runSessionInsertStub(),
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

function catalogRunner(
  id: string,
  capabilityAgent: string,
): Record<string, unknown> {
  return {
    id,
    adapter: capabilityAgent,
    capabilityAgent,
    model: `${capabilityAgent}-model`,
    providerKind: capabilityAgent === "claude" ? "anthropic" : "openai",
    permissionPolicy: "default",
    enabled: true,
    ready: true,
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
  let artifactLocator: unknown;
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((value: { locator?: unknown }) => {
        if (value.locator) artifactLocator = value.locator;

        return { onConflictDoNothing: vi.fn(async () => undefined) };
      }),
    })),
    // A real transaction can read. `createHitlRequest` — the one writer of
    // hitl_requests — reads the run back to resolve the project the
    // `run.needs_input` event belongs to, so a tx stub with only `insert`
    // models a transaction that does not exist.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            projectId: "project-1",
            taskId: "task-1",
            locator: artifactLocator,
          },
        ]),
      })),
    })),
  };
  const queue = [...rows];

  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    insert: runSessionInsertStub(),
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
        flowRevisionId: "rev-1",
      },
      manifest: { runner_profiles: undefined },
      runner: { id: "runner-parent" },
      executor: {
        id: "runner-parent",
        agent: "claude",
        model: "sonnet",
        env: null,
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
    nodeAttemptId: "attempt-1",
    nodeAttemptNumber: 1,
    db: db(),
    rootDb: { root: true },
    ...overrides,
  } as unknown as Parameters<typeof runConsensusNode>[0];
}

beforeEach(() => {
  runSessionInserts.length = 0;
  vi.resetAllMocks();
  acquireConsensusAgentCapacity.mockResolvedValue(releaseCapacity);
  loadRunnerCatalog.mockResolvedValue([
    catalogRunner("claude", "claude"),
    catalogRunner("codex", "codex"),
  ]);
  loadFlowRunnerBindings.mockResolvedValue([]);
  loadProjectPlatformRunnerDefaults.mockResolvedValue({
    project: { defaultRunnerId: null },
    platform: { defaultRunnerId: null },
  });
  loadConsensusVerdicts.mockResolvedValue([]);
  loadConsensusDraftFailureReasons.mockResolvedValue({});
  // S2.7: a verification/synthesis turn is applied by its prompt owner; the
  // runtime reads the applied row back instead of the live stdout.
  loadConsensusVerdictCell.mockResolvedValue(null);
  loadConsensusSynthesis.mockResolvedValue(null);
  atomicWriteJson.mockResolvedValue(undefined);
  createHitlAssignmentForRun.mockResolvedValue(undefined);
  emitWebhookEvent.mockResolvedValue(undefined);
  recordCurrentArtifact.mockResolvedValue({ id: "artifact" });
  resolveConsensusHumanRequest.mockResolvedValue({
    hitlRequestId: "hitl-1",
    sourceRound: 1,
    responseDigest: "response-digest",
  });
  prepareConsensusHumanIntent.mockResolvedValue({
    version: 1,
    hitlRequestId: "hitl-1",
    nodeAttemptId: "attempt-1",
    sourceRound: 1,
    targetRound: 2,
    decision: "re-run-round",
    responseDigest: "response-digest",
  });
  isConsensusHumanIntentApplied.mockResolvedValue(false);
  markConsensusHumanIntentApplied.mockResolvedValue(undefined);
});

describe("consensus prompt templates", () => {
  const baseContext = input().context;

  it("renders a draft full of Mustache syntax into the verifier prompt byte-for-byte", () => {
    const draftText =
      "x {{ nope }} {{#s}}y{{/s}} {{> partial }} {{{ raw }}} {{ z";

    const rendered = renderStrict(
      verifierPrompt(),
      withConsensusVars(baseContext, {
        verifier_id: "qa",
        target_participant_id: "architect",
        material_axes: JSON.stringify(["scope"]),
        target_draft: draftText,
      }) as unknown as Record<string, unknown>,
    );

    expect(rendered).toContain(draftText);
    expect(rendered).toContain("Verifier id: qa");
    expect(rendered).not.toContain("{{ consensus.");
  });

  it("renders task text and agreed material with braces into the synthesis prompt unchanged", () => {
    const rendered = renderStrict(
      synthesisPrompt(),
      withConsensusVars(baseContext, {
        source: "consensus",
        prompt: "Plan for {{ literal }} in the task",
        selected_text: "Plan A {{ nope }}",
        debate_log: '{"claim":"{{ x }}"}',
      }) as unknown as Record<string, unknown>,
    );

    expect(rendered).toContain("Plan for {{ literal }} in the task");
    expect(rendered).toContain("Plan A {{ nope }}");
    expect(rendered).toContain('{"claim":"{{ x }}"}');
    expect(rendered).not.toContain("{{ consensus.");
  });
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
    const prompts = launchConsensusDraftRuns.mock.calls[0][0].prompts as Array<{
      prompt: string;
    }>;

    expect(prompts).toHaveLength(2);
    expect(
      prompts.every((item) =>
        item.prompt.endsWith(
          "Return the complete draft as your final message text. File writes are refused in this workspace. Do not reference files as the deliverable. Include the full draft in the final message, even when revising a previous draft.",
        ),
      ),
    ).toBe(true);
  });

  // The draft children outlive the parent's traversal (the coordinator parks
  // and releases its assignment right after fan-out), so their dispatch must
  // ride the root handle; the traversal handle stays for the fan-out's own rows.
  it("hands the draft fan-out the root database handle beside the traversal handle", async () => {
    const rootDb = { root: true };

    latestConsensusRound.mockResolvedValue(0);
    loadConsensusDraftEvidence.mockResolvedValue([]);
    launchConsensusDraftRuns.mockResolvedValue([
      { participantId: "architect", runId: "child-1", status: "Running" },
      { participantId: "qa", runId: "child-2", status: "Running" },
    ]);
    const args = input({ rootDb });

    await runConsensusNode(args);

    expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
      expect.objectContaining({ db: args.db, rootDb }),
    );
  });

  // A round in which no participant produced a draft is an infrastructure
  // failure, not a disagreement: verifying fail-closed over nothing, spending a
  // second round on nothing and then asking a human to pick between empty
  // drafts hides the real error. The node fails with the children's evidence.
  it("fails the node with CRASH when no settled draft in the round is available", async () => {
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 2 },
    } as ConsensusNodeDef;

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      {
        ...draft("architect", ""),
        status: "Crashed",
        artifactId: null,
        artifactText: null,
      },
      {
        ...draft("qa", ""),
        status: "Failed",
        artifactId: null,
        artifactText: null,
      },
    ]);
    loadConsensusDraftFailureReasons.mockResolvedValue({
      "child-architect": "reconcile: agent-session-gone",
    });

    await expect(runConsensusNode(input({ def }))).rejects.toMatchObject({
      code: "CRASH",
      message: expect.stringContaining("agent-session-gone"),
      details: expect.objectContaining({
        reason: "consensus_no_draft_available",
        round: 1,
        drafts: [
          expect.objectContaining({
            participantId: "architect",
            runId: "child-architect",
            status: "Crashed",
            reason: "reconcile: agent-session-gone",
          }),
          expect.objectContaining({
            participantId: "qa",
            runId: "child-qa",
            status: "Failed",
            reason: null,
          }),
        ],
      }),
    });
    expect(loadConsensusDraftFailureReasons).toHaveBeenCalledWith(
      expect.objectContaining({ runIds: ["child-architect", "child-qa"] }),
    );
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(recordConsensusVerdict).not.toHaveBeenCalled();
    expect(launchConsensusDraftRuns).not.toHaveBeenCalled();
    expect(atomicWriteJson).not.toHaveBeenCalled();
  });

  it("re-fans an all-partial round without paying for verification", async () => {
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 2 },
    } as ConsensusNodeDef;
    const partial = (
      participantId: string,
      body: string,
    ): ConsensusDraftEvidence => ({
      ...draft(participantId, body),
      status: "Failed",
      classification: "partial",
      stopReason: "max_tokens",
      reason: "consensus_draft_incomplete",
    });

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      partial("architect", "partial architecture"),
      {
        ...partial("qa", "partial QA"),
        stopReason: "end_turn",
        reason: "output_cap_exceeded",
      },
    ]);
    recordConsensusVerdict.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        verdict: "disagree",
        parseStatus: "invalid_json",
        errorCode: args.errorCode,
        axes: { scope: false, risk: false },
      }),
    );
    loadConsensusVerdicts.mockImplementation(async () =>
      recordConsensusVerdict.mock.calls.length === 2
        ? [
            verdict("qa", "architect", {
              verdict: "disagree",
              errorCode: "draft_partial",
            }),
            verdict("architect", "qa", {
              verdict: "disagree",
              errorCode: "draft_partial",
            }),
          ]
        : [],
    );
    launchConsensusDraftRuns.mockResolvedValue([
      {
        participantId: "architect",
        runId: "next-architect",
        status: "Running",
      },
      { participantId: "qa", runId: "next-qa", status: "Running" },
    ]);

    const result = await runConsensusNode(input({ def }));
    const prompts = launchConsensusDraftRuns.mock.calls[0][0].prompts as Array<{
      participantId: string;
      prompt: string;
    }>;

    expect(result.waitsForChildren).toBe(true);
    expect(recordConsensusVerdict).toHaveBeenCalledTimes(2);
    expect(
      recordConsensusVerdict.mock.calls.every(
        ([args]) => args.errorCode === "draft_partial",
      ),
    ).toBe(true);
    expect(runAgentStep).not.toHaveBeenCalled();
    expect(acquireConsensusAgentCapacity).not.toHaveBeenCalled();
    expect(
      prompts.find((item) => item.participantId === "qa")?.prompt,
    ).toContain("partial QA");
    expect(
      prompts.find((item) => item.participantId === "qa")?.prompt,
    ).toContain("draft exceeded the 1048576-byte output cap");
    expect(
      prompts.find((item) => item.participantId === "qa")?.prompt,
    ).not.toContain("partial architecture");
  });

  it("renders the draft prompt against the run template context", async () => {
    latestConsensusRound.mockResolvedValue(0);
    loadConsensusDraftEvidence.mockResolvedValue([]);
    launchConsensusDraftRuns.mockResolvedValue([
      { participantId: "architect", runId: "child-1", status: "Running" },
      { participantId: "qa", runId: "child-2", status: "Pending" },
    ]);
    const def = { ...consensusDef(), prompt: "Plan for: {{ task.prompt }}" };

    await runConsensusNode(input({ def }));

    expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        prompts: expect.arrayContaining([
          expect.objectContaining({
            prompt: expect.stringContaining("Plan for: Prompt"),
          }),
        ]),
      }),
    );
  });

  it("refuses an unknown template variable in the draft prompt with CONFIG", async () => {
    latestConsensusRound.mockResolvedValue(0);
    loadConsensusDraftEvidence.mockResolvedValue([]);
    const def = {
      ...consensusDef(),
      prompt: "Plan for: {{ steps.intake.vars.missing }}",
    };

    await expect(runConsensusNode(input({ def }))).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(launchConsensusDraftRuns).not.toHaveBeenCalled();
  });

  it("renders the guarded default form in the draft prompt", async () => {
    latestConsensusRound.mockResolvedValue(0);
    loadConsensusDraftEvidence.mockResolvedValue([]);
    launchConsensusDraftRuns.mockResolvedValue([
      { participantId: "architect", runId: "child-1", status: "Running" },
      { participantId: "qa", runId: "child-2", status: "Pending" },
    ]);
    const def = {
      ...consensusDef(),
      prompt: "Plan for: {{ steps.intake.vars.tests ?? 'unspecified' }}",
    };

    await runConsensusNode(input({ def }));

    expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        prompts: expect.arrayContaining([
          expect.objectContaining({
            prompt: expect.stringContaining("Plan for: unspecified"),
          }),
        ]),
      }),
    );
  });

  it("fails an applied max_tokens synthesis as a named recoverable crash", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan A"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId),
    );
    loadConsensusSynthesis.mockResolvedValue({
      kind: "incomplete",
      synthesisId: "synthesis-1",
      text: "Partial synthesis text",
      stopReason: "max_tokens",
    });

    await expect(runConsensusNode(input())).rejects.toMatchObject({
      code: "CRASH",
      details: {
        reason: "consensus_synthesis_incomplete",
        stopReason: "max_tokens",
        synthesisId: "synthesis-1",
      },
    });
    expect(recordCurrentArtifact).not.toHaveBeenCalled();
  });

  it("passes the draft to the verifier as a template value, never inside the template", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A with {{ braces }}"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId),
    );
    loadConsensusSynthesis.mockResolvedValue(synthesis("Final consensus plan"));

    await runConsensusNode(input());

    const verifierCall = runAgentStep.mock.calls.find(
      (call) => call[0]?.id === "decide:verify:1:qa:architect",
    );

    expect(verifierCall).toBeDefined();
    expect(verifierCall?.[0].prompt).toContain("{{ consensus.target_draft }}");
    expect(verifierCall?.[0].prompt).not.toContain("Plan A");
    expect(verifierCall?.[1].context.consensus).toEqual(
      expect.objectContaining({
        verifier_id: "qa",
        target_participant_id: "architect",
        target_draft: "Plan A with {{ braces }}",
      }),
    );
  });

  it("passes the rendered prompt and the agreed material to the synthesizer as template values", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan A"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId),
    );
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final consensus plan"));
    const def = {
      ...consensusDef(),
      prompt: "Pick a plan for {{ task.prompt }}.",
    };

    await runConsensusNode(input({ def }));

    const synthesisCall = runAgentStep.mock.calls.find(
      (call) => call[0]?.id === "decide:synthesize",
    );

    expect(synthesisCall).toBeDefined();
    expect(synthesisCall?.[0].prompt).toContain("{{ consensus.prompt }}");
    expect(synthesisCall?.[0].prompt).toContain(
      "{{ consensus.selected_text }}",
    );
    expect(synthesisCall?.[0].prompt).not.toContain("Plan A");
    expect(synthesisCall?.[1].context.consensus).toEqual(
      expect.objectContaining({
        prompt: "Pick a plan for Prompt.",
        selected_text: expect.stringContaining("Plan A"),
      }),
    );
  });

  it("names every substep session for its own substep, never the run's default", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan A"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId),
    );
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final consensus plan"));

    await runConsensusNode(input());

    const names: Array<string | undefined> = runAgentStep.mock.calls.map(
      (call: unknown[]) => (call[1] as { sessionName?: string }).sessionName,
    );

    // A substep session that answers to "default" claims the run's main logical
    // session: its create ack rebinds that session's ACP handle, and its
    // incarnation collides with the live one on the active-incarnation index.
    expect(names.length).toBeGreaterThan(1);
    expect(names).not.toContain("default");
    expect(names).not.toContain(undefined);
    expect(new Set(names).size).toBe(names.length);
    expect(names.at(-1)).toBe("decide-synthesize");
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
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
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [
          {
            axis: "scope",
            claim: "scope mismatch",
            counterEvidence: "drafts differ",
          },
        ],
      }),
    );

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
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [
          {
            axis: "scope",
            claim: "scope mismatch",
            counterEvidence: "drafts differ",
          },
        ],
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

  // A verify substep names its own session, so nothing pre-inserts its
  // `run_sessions` row at launch — `applyCreateAck` would otherwise INSERT it
  // with every runner column NULL. That row then OUTRANKS the node's own in
  // `activeRunSessionScalar` (live handle first, then newest), which is what
  // took `runnerAgentFromFields` — and the portfolio/board/run/inbox screens
  // reading it — down. Seed it with the runner the verifier actually spawns on.
  it("seeds each verify substep session row with its own resolved runner", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"agree","axes":{"scope":true,"risk":true},"disagreements":[]}',
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        verdict: "agree",
        axes: { scope: true, risk: true },
        disagreements: [],
      }),
    );
    loadConsensusSynthesis.mockResolvedValue(synthesis("Agreed plan"));

    await runConsensusNode(
      input({
        db: dbWithRunnerRows([
          runnerRow("claude", "claude"),
          runnerRow("codex", "codex"),
          runnerRow("claude", "claude"),
        ]),
      }),
    );

    // Every substep row carries a runner, synthesis included — the helper is
    // the same, so a regression in either path shows up here.
    for (const seed of runSessionInserts) {
      expect(seed.capabilityAgent).not.toBeNull();
      expect(seed.runnerSnapshot).not.toBeNull();
    }
    expect(
      runSessionInserts.some((row) =>
        String(row.sessionName).endsWith("-synthesize"),
      ),
    ).toBe(true);

    const verifySeeds = runSessionInserts.filter((row) =>
      String(row.sessionName).includes("-verify-"),
    );

    expect(verifySeeds.length).toBeGreaterThan(0);
    for (const seed of verifySeeds) {
      expect(seed.capabilityAgent).not.toBeNull();
      expect(seed.runnerSnapshot).toEqual(
        expect.objectContaining({ capabilityAgent: seed.capabilityAgent }),
      );
    }

    // The two verifiers resolve to DIFFERENT runners — the fact a shared
    // `default` row could never have recorded.
    expect(new Set(verifySeeds.map((seed) => seed.capabilityAgent))).toEqual(
      new Set(["claude", "codex"]),
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
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId),
    );
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final consensus plan"));

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
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final cached-verdict plan"));

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
    runAgentStep.mockRejectedValue(new Error("spawn failed"));
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

  // ADR-166 E-EH-11: a verifier turn fenced by a newer driver generation is
  // NOT a fail-closed verdict — nothing is recorded and the typed yield
  // propagates for the graph runner to honour.
  it("a fenced verifier turn records no verdict and propagates the yield", async () => {
    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "A"),
      draft("qa", "B"),
    ]);
    loadConsensusVerdicts.mockResolvedValue([]);
    runAgentStep.mockResolvedValueOnce({
      ok: false,
      fenced: true,
      stdout: "",
      vars: {},
      errorCode: "CONFLICT",
    });

    await expect(runConsensusNode(input())).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "assignment_fenced" },
    });
    expect(recordConsensusVerdict).not.toHaveBeenCalled();
    expect(releaseCapacity).toHaveBeenCalledTimes(1);
  });

  it("re-fans an axis-only disagreement with the addressed verdict and own draft", async () => {
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 2 },
    } as ConsensusNodeDef;
    const qaPrior = `{{ literal }}${"X".repeat(70_000)}`;

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", qaPrior),
    ]);
    loadConsensusVerdicts.mockResolvedValue([
      verdict("architect", "qa", {
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [],
      }),
    ]);
    launchConsensusDraftRuns.mockResolvedValue([
      { participantId: "architect", runId: "child-1", status: "Running" },
      { participantId: "qa", runId: "child-2", status: "Running" },
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout:
        '{"verdict":"disagree","axes":{"scope":false,"risk":true},"disagreements":[]}',
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [],
      }),
    );
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
        prompts: expect.arrayContaining([
          expect.objectContaining({
            prompt: expect.stringContaining("Round critique"),
          }),
        ]),
      }),
    );
    const prompts = launchConsensusDraftRuns.mock.calls[0][0].prompts as Array<{
      participantId: string;
      prompt: string;
    }>;
    const architect = prompts.find(
      (item) => item.participantId === "architect",
    )!.prompt;
    const qa = prompts.find((item) => item.participantId === "qa")!.prompt;

    expect(qa).toContain("axis scope judged false by verifier architect");
    expect(qa).toContain("Verdict on your previous draft:");
    expect(architect).not.toContain(
      "Verifier architect on architect:\naxis scope judged false",
    );
    expect(qa).toContain("Your previous draft:\n\n{{ literal }}");
    expect(qa).toContain("consensus text truncated: dropped");
    expect(qa).not.toContain(qaPrior);
    expect(qa).not.toContain("Plan A");
    expect(architect).toContain("Your previous draft:\n\nPlan A");
    expect(architect).not.toContain("{{ literal }}");
  });

  it("escalates a verifier-only invalid JSON round without buying another draft", async () => {
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 2 },
    } as ConsensusNodeDef;

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    launchConsensusDraftRuns.mockResolvedValue([]);
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        parseStatus: "invalid_json",
        verdict: "disagree",
        axes: { scope: false, risk: false },
        disagreements: [],
        errorCode: "invalid_json",
      }),
    );
    runAgentStep.mockResolvedValue({ ok: true, stdout: "not JSON", vars: {} });

    const result = await runConsensusNode(input({ def }));

    expect(result.needsInput).toBe(true);
    expect(result.waitsForChildren).toBe(false);
    expect(launchConsensusDraftRuns).not.toHaveBeenCalled();
    expect(atomicWriteJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        schema: expect.objectContaining({
          technicalFailures: expect.arrayContaining([
            expect.objectContaining({ errorCode: "invalid_json" }),
          ]),
        }),
      }),
    );
  });

  it("appends the round-2 critique after rendering, so braces in a claim stay literal", async () => {
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 2 },
    } as ConsensusNodeDef;
    const claim = "scope {{ nope }} mismatch";

    latestConsensusRound.mockResolvedValue(1);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "Plan A"),
      draft("qa", "Plan B"),
    ]);
    loadConsensusVerdicts.mockResolvedValue([
      verdict("architect", "qa", {
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [
          { axis: "scope", claim, counterEvidence: "drafts differ" },
        ],
      }),
    ]);
    launchConsensusDraftRuns.mockResolvedValue([
      { participantId: "architect", runId: "child-1", status: "Running" },
      { participantId: "qa", runId: "child-2", status: "Running" },
    ]);
    runAgentStep.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [
          { axis: "scope", claim, counter_evidence: "drafts differ" },
        ],
      }),
      vars: {},
    });
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        verdict: "disagree",
        axes: { scope: false, risk: true },
        disagreements: [
          { axis: "scope", claim, counterEvidence: "drafts differ" },
        ],
      }),
    );
    recordConsensusVerdict.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId, {
        parseStatus: args.result.parseStatus,
        verdict: args.result.verdict,
        axes: args.result.axes,
        disagreements: args.result.disagreements,
      }),
    );

    await runConsensusNode(input({ def }));

    expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        round: 2,
        prompts: expect.arrayContaining([
          expect.objectContaining({
            prompt: expect.stringContaining(`[scope] ${claim}`),
          }),
        ]),
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
    loadConsensusVerdictCell.mockImplementation(async (args) =>
      verdict(args.verifierId, args.targetParticipantId),
    );
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final consensus plan"));
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
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final manual consensus plan"));
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

  it("pins a human rerun to the delivered round and adopts its target on replay", async () => {
    const files = await runtimeInputFile({ decision: "re-run-round" });
    const def = {
      ...consensusDef(),
      rounds: { mode: "iterate", max: 3 },
    } as ConsensusNodeDef;

    latestConsensusRound.mockResolvedValue(2);
    loadConsensusDraftEvidence.mockResolvedValue([
      draft("architect", "architect prior"),
      draft("qa", "qa prior"),
    ]);
    loadConsensusVerdicts.mockResolvedValue([
      verdict("architect", "qa", {
        verdict: "disagree",
        parseStatus: "invalid_json",
        errorCode: "invalid_json",
        axes: { scope: false, risk: false },
      }),
      verdict("qa", "architect", {
        verdict: "disagree",
        parseStatus: "invalid_json",
        errorCode: "invalid_json",
        axes: { scope: false, risk: false },
      }),
    ]);
    launchConsensusDraftRuns.mockResolvedValue([
      {
        participantId: "architect",
        runId: "round-2-architect",
        status: "Running",
      },
      { participantId: "qa", runId: "round-2-qa", status: "Running" },
    ]);

    try {
      const result = await runConsensusNode(
        input({ def, runtimeRoot: files.runtimeRoot }),
      );

      expect(result.waitsForChildren).toBe(true);
      expect(loadConsensusDraftEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ round: 1 }),
      );
      expect(launchConsensusDraftRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          round: 2,
          prompts: expect.arrayContaining([
            expect.objectContaining({
              participantId: "qa",
              prompt: expect.stringContaining("qa prior"),
            }),
          ]),
        }),
      );
      expect(markConsensusHumanIntentApplied).toHaveBeenCalledTimes(1);
      await writeFile(
        files.inputPath,
        JSON.stringify({ decision: "re-run-round" }),
      );
      isConsensusHumanIntentApplied.mockResolvedValue(true);

      const replay = await runConsensusNode(
        input({ def, runtimeRoot: files.runtimeRoot }),
      );

      expect(replay.waitsForChildren).toBe(true);
      expect(launchConsensusDraftRuns).toHaveBeenCalledTimes(1);
      await expect(readFile(files.inputPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
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
    loadConsensusSynthesis
      .mockResolvedValueOnce(null)
      .mockResolvedValue(synthesis("Final manual consensus plan"));

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
