import "server-only";

import type {
  AcpSessionState,
  FlowContext,
  StepResult,
} from "@/lib/flows/types";
import type { CompiledNode } from "../compile";
import type { Db, LoadedRun } from "../runner-core";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { ConsensusNodeDef } from "./drafts";
import type { ConsensusDisagreement, ParsedConsensusVerdict } from "./verdict";
import type { ConsensusRoleRuntime } from "./roles";

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { recordCurrentArtifact } from "../artifact-store";

import { launchConsensusDraftRuns } from "./drafts";
import { buildConsensusRotation } from "./rotation";
import { tallyConsensus, type ConsensusTallyResult } from "./tally";
import { parseConsensusVerdict } from "./verdict";
import { acquireConsensusAgentCapacity } from "./capacity";
import { resolveConsensusRoleRuntime } from "./roles";
import {
  CONSENSUS_TEXT_CAP_BYTES,
  latestConsensusRound,
  loadConsensusDraftEvidence,
  loadConsensusVerdicts,
  recordConsensusVerdict,
  type ConsensusDraftEvidence,
  type ConsensusVerdictEvidence,
} from "./ledger";

import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { runAgentStep } from "@/lib/flows/runner-agent";
import { MaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { atomicWriteJson } from "@/lib/atomic";
import { createHitlAssignmentForRun } from "@/lib/assignments/service";

const { hitlRequests } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "consensus-runtime",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ConsensusNodeResult = StepResult & {
  needsInput?: boolean;
  waitsForChildren?: boolean;
};

type RunConsensusNodeInput = {
  node: CompiledNode;
  def: ConsensusNodeDef;
  loaded: LoadedRun;
  context: FlowContext;
  runtimeRoot: string;
  worktreePath: string;
  sessionState: AcpSessionState;
  supervisorApi?: SupervisorApi;
  nodeAttemptId: string;
  nodeAttemptNumber: number;
  db: Db;
};

type ConsensusHumanDecision = {
  decision: string;
  resolution?: string;
};

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function runDir(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): string {
  return path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

function capText(text: string): string {
  return text.slice(0, CONSENSUS_TEXT_CAP_BYTES);
}

function failClosedVerdict(
  materialAxes: readonly string[],
): ParsedConsensusVerdict {
  return parseConsensusVerdict("", materialAxes);
}

async function readConsensusHumanDecision(
  inputPath: string,
): Promise<ConsensusHumanDecision | null> {
  let raw: string;

  try {
    raw = await readFile(inputPath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }

    throw err;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `failed to parse consensus input artifact at ${inputPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MaisterError(
      "CONFIG",
      `consensus input artifact at ${inputPath} must be an object`,
    );
  }

  const decision = (parsed as Record<string, unknown>).decision;
  const resolution = (parsed as Record<string, unknown>).resolution;

  if (typeof decision !== "string") {
    throw new MaisterError(
      "CONFIG",
      `consensus input artifact at ${inputPath} is missing decision`,
    );
  }

  return {
    decision,
    ...(typeof resolution === "string" ? { resolution } : {}),
  };
}

async function consumeConsensusHumanDecision(args: {
  inputPath: string;
  runId: string;
  nodeId: string;
  decision: string;
  round: number;
}): Promise<void> {
  try {
    await unlink(args.inputPath);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;

    throw err;
  }

  log.info(
    {
      runId: args.runId,
      nodeId: args.nodeId,
      decision: args.decision,
      round: args.round,
    },
    "[FIX:consensus] consensus human input consumed after durable side effects",
  );
}

function participantOrder(def: ConsensusNodeDef): string[] {
  return def.participants.map((participant) => participant.id);
}

function participantById(
  def: ConsensusNodeDef,
  participantId: string,
): ConsensusNodeDef["participants"][number] {
  const participant = def.participants.find(
    (item) => item.id === participantId,
  );

  if (!participant) {
    throw new MaisterError(
      "CONFIG",
      `consensus verifier participant "${participantId}" is not declared`,
    );
  }

  return participant;
}

function consensusRoleCtx(args: RunConsensusNodeInput): {
  db: Db;
  projectId: string;
  taskId: string | null;
} {
  return {
    db: args.db,
    projectId: args.loaded.run.projectId,
    taskId: args.loaded.run.taskId,
  };
}

function resolveVerifierRuntime(
  args: RunConsensusNodeInput & { verifierId: string },
): Promise<ConsensusRoleRuntime> {
  return resolveConsensusRoleRuntime({
    ...consensusRoleCtx(args),
    role: participantById(args.def, args.verifierId),
    roleLabel: `consensus verifier participant "${args.verifierId}"`,
  });
}

function resolveSynthesizerRuntime(
  args: RunConsensusNodeInput,
): Promise<ConsensusRoleRuntime> {
  return resolveConsensusRoleRuntime({
    ...consensusRoleCtx(args),
    role: args.def.synthesizer,
    roleLabel: "consensus synthesizer",
  });
}

function roundLimit(def: ConsensusNodeDef): number {
  return def.rounds.mode === "single_pass" ? 1 : def.rounds.max;
}

function orderedDrafts(
  def: ConsensusNodeDef,
  drafts: readonly ConsensusDraftEvidence[],
): ConsensusDraftEvidence[] {
  const byId = new Map(drafts.map((draft) => [draft.participantId, draft]));

  return participantOrder(def)
    .map((id) => byId.get(id))
    .filter((draft): draft is ConsensusDraftEvidence => draft !== undefined);
}

function allDraftsSettled(
  def: ConsensusNodeDef,
  drafts: readonly ConsensusDraftEvidence[],
): boolean {
  const byId = new Map(drafts.map((draft) => [draft.participantId, draft]));

  return def.participants.every((participant) => {
    const draft = byId.get(participant.id);

    return (
      draft !== undefined &&
      ["Done", "Failed", "Crashed", "Abandoned", "Review"].includes(
        draft.status,
      )
    );
  });
}

function roundPrompt(args: {
  basePrompt: string;
  round: number;
  disagreements: readonly ConsensusDisagreement[];
}): string {
  if (args.round <= 1 || args.disagreements.length === 0) {
    return args.basePrompt;
  }

  const critique = args.disagreements
    .slice(0, 12)
    .map(
      (item, index) =>
        `${index + 1}. [${item.axis}] ${item.claim} (${item.counterEvidence})`,
    )
    .join("\n");

  return [
    args.basePrompt,
    "## Prior-round critique",
    "Address these unresolved material disagreements in this round:",
    critique,
  ].join("\n\n");
}

async function launchRound(
  args: RunConsensusNodeInput & {
    round: number;
    disagreements?: readonly ConsensusDisagreement[];
  },
): Promise<ConsensusNodeResult> {
  const draftRuns = await launchConsensusDraftRuns({
    db: args.db,
    projectId: args.loaded.run.projectId,
    taskId: args.loaded.run.taskId,
    parentRunId: args.loaded.run.id,
    rootRunId: args.loaded.run.rootRunId ?? args.loaded.run.id,
    nodeId: args.node.id,
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
    prompt: roundPrompt({
      basePrompt: args.def.prompt,
      round: args.round,
      disagreements: args.disagreements ?? [],
    }),
    participants: args.def.participants,
    workspaceMode: args.def.workspace?.mode ?? "repo_read",
  });

  log.info(
    {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      round: args.round,
      childRunIds: draftRuns.map((draft) => draft.runId),
      participantIds: draftRuns.map((draft) => draft.participantId),
      workspaceMode: args.def.workspace?.mode ?? "repo_read",
    },
    "consensus draft fan-out completed",
  );

  return {
    ok: true,
    stdout: "",
    vars: { consensusDraftRuns: draftRuns, round: args.round },
    durationMs: 0,
    needsInput: true,
    waitsForChildren: true,
  };
}

function verifierPrompt(args: {
  materialAxes: readonly string[];
  verifierId: string;
  target: ConsensusDraftEvidence;
}): string {
  return [
    "You are a consensus verifier. Audit the target draft against every material axis.",
    `Verifier id: ${args.verifierId}`,
    `Target participant id: ${args.target.participantId}`,
    "",
    "Material axes:",
    JSON.stringify(args.materialAxes),
    "",
    "Target draft excerpt:",
    capText(args.target.artifactText ?? ""),
    "",
    "Return only a JSON object with this shape:",
    '{"verdict":"agree|disagree","axes":{"axis":true},"disagreements":[{"axis":"axis","claim":"...","counter_evidence":"..."}],"confidence":0.5}',
  ].join("\n");
}

async function runVerifier(
  args: RunConsensusNodeInput & {
    round: number;
    verifierId: string;
    target: ConsensusDraftEvidence;
  },
): Promise<ConsensusVerdictEvidence> {
  const startedAt = Date.now();
  const release = await acquireConsensusAgentCapacity({
    runId: args.loaded.run.id,
    nodeId: args.node.id,
    phase: "verify",
    actorId: args.verifierId,
  });
  let rawOutput = "";
  let parsed: ParsedConsensusVerdict;
  let errorCode: string | undefined;
  let verifierRuntime: ConsensusRoleRuntime | null = null;

  try {
    if (args.target.status !== "Done" || !args.target.artifactText) {
      parsed = failClosedVerdict(args.def.material_axes);
      errorCode = "draft_unavailable";
    } else {
      verifierRuntime = await resolveVerifierRuntime(args);
      const res = await runAgentStep(
        {
          id: `${args.node.id}:verify:${args.round}:${args.verifierId}:${args.target.participantId}`,
          type: "agent",
          mode: "new-session",
          prompt: verifierPrompt({
            materialAxes: args.def.material_axes,
            verifierId: args.verifierId,
            target: args.target,
          }),
        },
        {
          runtimeRoot: args.runtimeRoot,
          projectSlug: args.loaded.projectSlug,
          runId: args.loaded.run.id,
          stepId: `${args.node.id}:verify`,
          nodeAttemptId: args.nodeAttemptId,
          worktreePath: args.worktreePath,
          executor: {
            id: verifierRuntime.executor.id,
            agent: verifierRuntime.executor.agent,
            model: verifierRuntime.executor.model,
            env: (verifierRuntime.executor.env ?? undefined) as
              | Record<string, string>
              | undefined,
            router: verifierRuntime.executor.router ?? undefined,
          },
          ...(verifierRuntime.runner ? { runner: verifierRuntime.runner } : {}),
          ...(verifierRuntime.adapterLaunch
            ? { adapterLaunch: verifierRuntime.adapterLaunch }
            : {}),
          ...(verifierRuntime.agentBinding
            ? { agentBinding: verifierRuntime.agentBinding }
            : {}),
          db: args.db,
          context: args.context,
          sessionState: args.sessionState,
        },
        args.supervisorApi,
      );

      rawOutput = res.stdout ?? "";
      parsed = parseConsensusVerdict(rawOutput, args.def.material_axes);
      if (!res.ok) errorCode = res.errorCode ?? "EXECUTOR_UNAVAILABLE";
    }
  } catch (err) {
    parsed = failClosedVerdict(args.def.material_axes);
    errorCode =
      err instanceof MaisterError
        ? err.code
        : err instanceof Error
          ? err.name
          : "UNKNOWN";
    rawOutput = err instanceof Error ? err.message : String(err);
  } finally {
    release();
    log.info(
      {
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        verifierId: args.verifierId,
        targetParticipantId: args.target.participantId,
        round: args.round,
        roleKind: verifierRuntime?.roleKind ?? null,
        roleRef: verifierRuntime?.roleRef ?? null,
        capacityTokenReleased: true,
      },
      "consensus verifier capacity released",
    );
  }

  const recorded = await recordConsensusVerdict({
    db: args.db,
    runId: args.loaded.run.id,
    nodeId: args.node.id,
    nodeAttemptId: args.nodeAttemptId,
    attempt: args.nodeAttemptNumber,
    round: args.round,
    verifierId: args.verifierId,
    targetParticipantId: args.target.participantId,
    result: parsed,
    rawOutput,
    ...(errorCode ? { errorCode } : {}),
  });

  log.info(
    {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      verifierId: args.verifierId,
      targetParticipantId: args.target.participantId,
      round: args.round,
      roleKind: verifierRuntime?.roleKind ?? null,
      roleRef: verifierRuntime?.roleRef ?? null,
      verdict: recorded.verdict,
      parseStatus: recorded.parseStatus,
      durationMs: Date.now() - startedAt,
    },
    "consensus verification finished",
  );

  return recorded;
}

async function verifyConsensusRound(
  args: RunConsensusNodeInput & {
    round: number;
    drafts: readonly ConsensusDraftEvidence[];
  },
): Promise<ConsensusVerdictEvidence[]> {
  const existing = await loadConsensusVerdicts({
    db: args.db,
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
  });
  const byPair = new Map(
    existing.map((verdict) => [
      `${verdict.verifierId}:${verdict.targetParticipantId}`,
      verdict,
    ]),
  );
  const draftsByParticipant = new Map(
    args.drafts.map((draft) => [draft.participantId, draft]),
  );
  const verdicts: ConsensusVerdictEvidence[] = [];

  for (const assignment of buildConsensusRotation(participantOrder(args.def))) {
    const key = `${assignment.verifierId}:${assignment.targetParticipantId}`;
    const cached = byPair.get(key);

    if (cached) {
      verdicts.push(cached);
      continue;
    }

    const target = draftsByParticipant.get(assignment.targetParticipantId);

    if (!target) {
      const recorded = await recordConsensusVerdict({
        db: args.db,
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        nodeAttemptId: args.nodeAttemptId,
        attempt: args.nodeAttemptNumber,
        round: args.round,
        verifierId: assignment.verifierId,
        targetParticipantId: assignment.targetParticipantId,
        result: failClosedVerdict(args.def.material_axes),
        rawOutput: "target draft missing",
        errorCode: "target_missing",
      });

      verdicts.push(recorded);
      continue;
    }

    verdicts.push(
      await runVerifier({
        ...args,
        verifierId: assignment.verifierId,
        target,
      }),
    );
  }

  return verdicts;
}

function debateLogText(args: {
  source: string;
  round: number;
  tally: ConsensusTallyResult;
  verdicts: readonly ConsensusVerdictEvidence[];
  drafts: readonly ConsensusDraftEvidence[];
}): string {
  return capText(
    JSON.stringify(
      {
        source: args.source,
        round: args.round,
        tally: {
          agreementReached: args.tally.agreementReached,
          failedAxes: args.tally.failedAxes,
          disagreementCount: args.tally.disagreementCount,
          invalidVerdictCount: args.tally.invalidVerdictCount,
        },
        draftRefs: args.drafts.map((draft) => ({
          participantId: draft.participantId,
          runId: draft.runId,
          status: draft.status,
          artifactId: draft.artifactId,
        })),
        verdicts: args.verdicts.map((verdict) => ({
          verifierId: verdict.verifierId,
          targetParticipantId: verdict.targetParticipantId,
          parseStatus: verdict.parseStatus,
          verdict: verdict.verdict,
          axes: verdict.axes,
          disagreements: verdict.disagreements,
          rawOutputArtifactId: verdict.rawOutputArtifactId,
          errorCode: verdict.errorCode,
        })),
      },
      null,
      2,
    ),
  );
}

function synthesisPrompt(args: {
  source: string;
  basePrompt: string;
  selectedText: string;
  debateLog: string;
}): string {
  return [
    "Synthesize the final consensus answer.",
    `Source: ${args.source}`,
    "",
    "Original request:",
    args.basePrompt,
    "",
    "Selected or agreed material:",
    capText(args.selectedText),
    "",
    "Debate ledger summary:",
    args.debateLog,
    "",
    "Return only the final plan text. Do not mention internal participant ids unless they are necessary for the answer.",
  ].join("\n");
}

async function synthesizeConsensus(
  args: RunConsensusNodeInput & {
    round: number;
    source: string;
    selectedText: string;
    tally: ConsensusTallyResult;
    verdicts: readonly ConsensusVerdictEvidence[];
    drafts: readonly ConsensusDraftEvidence[];
  },
): Promise<ConsensusNodeResult> {
  const synthesizer = await resolveSynthesizerRuntime(args);

  const startedAt = Date.now();
  const debateLog = debateLogText(args);
  const release = await acquireConsensusAgentCapacity({
    runId: args.loaded.run.id,
    nodeId: args.node.id,
    phase: "synthesize",
    actorId: synthesizer.roleRef,
  });
  let planText = "";

  try {
    const res = await runAgentStep(
      {
        id: `${args.node.id}:synthesize`,
        type: "agent",
        mode: "new-session",
        prompt: synthesisPrompt({
          source: args.source,
          basePrompt: args.def.prompt,
          selectedText: args.selectedText,
          debateLog,
        }),
      },
      {
        runtimeRoot: args.runtimeRoot,
        projectSlug: args.loaded.projectSlug,
        runId: args.loaded.run.id,
        stepId: `${args.node.id}:synthesize`,
        nodeAttemptId: args.nodeAttemptId,
        worktreePath: args.worktreePath,
        executor: {
          id: synthesizer.executor.id,
          agent: synthesizer.executor.agent,
          model: synthesizer.executor.model,
          env: (synthesizer.executor.env ?? undefined) as
            | Record<string, string>
            | undefined,
          router: synthesizer.executor.router ?? undefined,
        },
        ...(synthesizer.runner ? { runner: synthesizer.runner } : {}),
        ...(synthesizer.adapterLaunch
          ? { adapterLaunch: synthesizer.adapterLaunch }
          : {}),
        ...(synthesizer.agentBinding
          ? { agentBinding: synthesizer.agentBinding }
          : {}),
        db: args.db,
        context: args.context,
        sessionState: args.sessionState,
      },
      args.supervisorApi,
    );

    if (!res.ok) {
      const code = res.errorCode ?? "EXECUTOR_UNAVAILABLE";

      throw new MaisterError(
        code,
        `consensus synthesizer failed for node ${args.node.id}`,
      );
    }

    planText = capText(res.stdout ?? "");
  } finally {
    release();
  }

  if (planText.trim().length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `consensus synthesizer produced empty output for node ${args.node.id}`,
    );
  }

  await recordCurrentArtifact(
    {
      id: `run:${args.nodeAttemptId}:consensus_plan`,
      runId: args.loaded.run.id,
      nodeAttemptId: args.nodeAttemptId,
      nodeId: args.node.id,
      attempt: args.nodeAttemptNumber,
      artifactDefId: "consensus_plan",
      kind: "plan",
      producer: "runner",
      locator: { kind: "inline", text: planText },
      validity: "current",
      requiredFor: ["review"],
      visibility: "shared",
      retention: "run",
    },
    args.db,
  );
  await recordCurrentArtifact(
    {
      id: `run:${args.nodeAttemptId}:debate_log`,
      runId: args.loaded.run.id,
      nodeAttemptId: args.nodeAttemptId,
      nodeId: args.node.id,
      attempt: args.nodeAttemptNumber,
      artifactDefId: "debate_log",
      kind: "human_note",
      producer: "runner",
      locator: { kind: "inline", text: debateLog },
      validity: "current",
      requiredFor: ["review"],
      visibility: "internal",
      retention: "run",
    },
    args.db,
  );

  log.info(
    {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      synthesizerId: synthesizer.roleRef,
      synthesizerKind: synthesizer.roleKind,
      source: args.source,
      artifactIds: ["consensus_plan", "debate_log"],
      durationMs: Date.now() - startedAt,
    },
    "consensus synthesis finished",
  );

  return {
    ok: true,
    stdout: "",
    vars: {
      consensus: {
        source: args.source,
        round: args.round,
        consensusPlanArtifactId: "consensus_plan",
        debateLogArtifactId: "debate_log",
      },
    },
    durationMs: Date.now() - startedAt,
  };
}

function hitlSchema(args: {
  round: number;
  maxRounds: number;
  drafts: readonly ConsensusDraftEvidence[];
  tally: ConsensusTallyResult;
  debateLog: string;
}): Record<string, unknown> {
  const choices = args.drafts.map((draft, index) => ({
    decision: `pick-draft-${index + 1}`,
    label: `Draft ${index + 1}`,
    artifactRef: draft.artifactId,
    excerpt: capText(draft.artifactText ?? "Draft unavailable."),
  }));
  const allowedDecisions = [
    ...choices.map((choice) => choice.decision),
    "provide-resolution",
    ...(args.round < args.maxRounds ? ["re-run-round"] : []),
    "abort",
  ];

  return {
    kind: "consensus_resolution",
    round: args.round,
    maxRounds: args.maxRounds,
    allowedDecisions,
    drafts: choices,
    disagreements: args.tally.disagreements.slice(0, 24).map((item) => ({
      axis: item.axis,
      summary: item.claim,
    })),
    debateLog: { excerpt: capText(args.debateLog) },
  };
}

async function createConsensusHitl(
  args: RunConsensusNodeInput & {
    round: number;
    maxRounds: number;
    drafts: readonly ConsensusDraftEvidence[];
    tally: ConsensusTallyResult;
    verdicts: readonly ConsensusVerdictEvidence[];
  },
): Promise<ConsensusNodeResult> {
  const debateLog = debateLogText({
    source: "no-consensus",
    round: args.round,
    tally: args.tally,
    verdicts: args.verdicts,
    drafts: args.drafts,
  });
  const schema = hitlSchema({
    round: args.round,
    maxRounds: args.maxRounds,
    drafts: args.drafts,
    tally: args.tally,
    debateLog,
  });
  const prompt = `Consensus node "${args.node.id}" needs a human resolution.`;
  const dir = runDir(
    args.runtimeRoot,
    args.loaded.projectSlug,
    args.loaded.run.id,
  );
  const needsInputPath = path.join(dir, "needs-input.json");
  const hitlRequestId = randomUUID();

  await atomicWriteJson(needsInputPath, {
    nodeId: args.node.id,
    kind: "consensus_resolution",
    schema,
    prompt,
    requestedAt: new Date().toISOString(),
  });

  try {
    await args.db.transaction(async (tx: Db) => {
      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId: args.loaded.run.id,
        stepId: args.node.id,
        kind: "human",
        schema,
        prompt,
      });
      await createHitlAssignmentForRun({
        db: tx,
        runId: args.loaded.run.id,
        hitlRequestId,
        nodeId: args.node.id,
        actionKind: "human_review",
        roleRefs: [],
        title: prompt,
      });
      await emitWebhookEvent({
        db: tx,
        type: "hitl.requested",
        projectId: args.loaded.run.projectId,
        runId: args.loaded.run.id,
        data: { hitlRequestId, kind: "human", nodeId: args.node.id },
      });
    });
  } catch (err) {
    await unlink(needsInputPath).catch((cleanupErr: unknown) => {
      log.warn(
        {
          runId: args.loaded.run.id,
          nodeId: args.node.id,
          hitlRequestId,
          err:
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr),
        },
        "consensus HITL cleanup failed after request creation error",
      );
    });
    throw err;
  }

  log.info(
    {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      hitlRequestId,
      round: args.round,
      decisionCount: (schema.allowedDecisions as string[]).length,
    },
    "consensus HITL created",
  );

  return {
    ok: false,
    stdout: "",
    vars: {},
    durationMs: 0,
    needsInput: true,
    waitsForChildren: false,
  };
}

function selectedDraftText(args: {
  decision: string;
  drafts: readonly ConsensusDraftEvidence[];
}): string {
  const index =
    Number.parseInt(args.decision.replace("pick-draft-", ""), 10) - 1;
  const draft = args.drafts[index];

  if (!draft?.artifactText) {
    throw new MaisterError(
      "PRECONDITION",
      `selected consensus draft ${args.decision} has no artifact text`,
    );
  }

  return draft.artifactText;
}

export async function runConsensusNode(
  args: RunConsensusNodeInput,
): Promise<ConsensusNodeResult> {
  const startedAt = Date.now();
  const inputPath = path.join(
    runDir(args.runtimeRoot, args.loaded.projectSlug, args.loaded.run.id),
    `input-${args.node.id}.json`,
  );
  const humanDecision = await readConsensusHumanDecision(inputPath);
  const currentRound = await latestConsensusRound({
    db: args.db,
    parentRunId: args.loaded.run.id,
    nodeAttemptId: args.nodeAttemptId,
  });
  const maxRounds = roundLimit(args.def);
  const round = Math.max(currentRound, 1);
  const drafts = orderedDrafts(
    args.def,
    await loadConsensusDraftEvidence({
      db: args.db,
      parentRunId: args.loaded.run.id,
      nodeAttemptId: args.nodeAttemptId,
      round,
    }),
  );

  if (humanDecision) {
    if (humanDecision.decision === "abort") {
      return {
        ok: false,
        stdout: "consensus aborted by human resolution",
        vars: {},
        durationMs: Date.now() - startedAt,
        errorCode: "PRECONDITION",
      };
    }
    if (humanDecision.decision === "re-run-round") {
      if (round >= maxRounds) {
        throw new MaisterError(
          "CONFLICT",
          `consensus node ${args.node.id} cannot re-run beyond round ${maxRounds}`,
        );
      }

      const result = await launchRound({ ...args, round: round + 1 });

      await consumeConsensusHumanDecision({
        inputPath,
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        decision: humanDecision.decision,
        round,
      });

      return result;
    }

    const selectedText =
      humanDecision.decision === "provide-resolution"
        ? humanDecision.resolution
        : selectedDraftText({ decision: humanDecision.decision, drafts });

    if (!selectedText) {
      throw new MaisterError(
        "PRECONDITION",
        "consensus human resolution did not include usable source text",
      );
    }

    const result = await synthesizeConsensus({
      ...args,
      round,
      source: humanDecision.decision,
      selectedText,
      tally: {
        agreementReached: false,
        disagreementCount: 0,
        failedAxes: [],
        disagreements: [],
        invalidVerdictCount: 0,
      },
      verdicts: await loadConsensusVerdicts({
        db: args.db,
        nodeAttemptId: args.nodeAttemptId,
        round,
      }),
      drafts,
    });

    await consumeConsensusHumanDecision({
      inputPath,
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      decision: humanDecision.decision,
      round,
    });

    return result;
  }

  if (currentRound === 0 || !allDraftsSettled(args.def, drafts)) {
    return launchRound({ ...args, round });
  }

  const verdicts = await verifyConsensusRound({ ...args, round, drafts });
  const tally = tallyConsensus({
    materialAxes: args.def.material_axes,
    verdicts,
  });

  log.info(
    {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      axes: args.def.material_axes,
      agreementReached: tally.agreementReached,
      round,
      disagreementCount: tally.disagreementCount,
    },
    "consensus tally completed",
  );

  if (tally.agreementReached) {
    const selectedText = drafts
      .map((draft) => draft.artifactText)
      .filter((text): text is string => !!text)
      .join("\n\n---\n\n");

    return synthesizeConsensus({
      ...args,
      round,
      source: "consensus",
      selectedText,
      tally,
      verdicts,
      drafts,
    });
  }

  if (args.def.rounds.mode === "iterate" && round < maxRounds) {
    return launchRound({
      ...args,
      round: round + 1,
      disagreements: tally.disagreements,
    });
  }

  return createConsensusHitl({
    ...args,
    round,
    maxRounds,
    drafts,
    tally,
    verdicts,
  });
}
