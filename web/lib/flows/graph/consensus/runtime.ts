import "server-only";

import type { FlowContext, StepResult } from "@/lib/flows/types";
import type { CompiledNode } from "../compile";
import type { Db, LoadedRun } from "../runner-core";
import type { AgentExecution } from "@/lib/flows/runner-agent";
import type { ConsensusNodeDef } from "./drafts";
import type { ParsedConsensusVerdict } from "./verdict";
import type { ConsensusRoleRuntime } from "./roles";

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import pino from "pino";
import { eq } from "drizzle-orm";

import { recordCurrentArtifact } from "../artifact-store";

import {
  isConsensusHumanIntentApplied,
  markConsensusHumanIntentApplied,
  prepareConsensusHumanIntent,
  resolveConsensusHumanRequest,
} from "./human-decision";
import { launchConsensusDraftRuns } from "./drafts";
import { prepareConsensusInputEvidence } from "./input-evidence";
import {
  composeConsensusRoundCritique,
  consensusDraftTrailer,
  hasActionableConsensusCritique,
  technicalConsensusFailures,
  type ConsensusTechnicalFailure,
} from "./critique";
import { buildConsensusRotation } from "./rotation";
import { tallyConsensus, type ConsensusTallyResult } from "./tally";
import { parseConsensusVerdict } from "./verdict";
import { acquireConsensusAgentCapacity } from "./capacity";
import { resolveConsensusRoleRuntime } from "./roles";
import {
  CONSENSUS_TEXT_CAP_BYTES,
  latestConsensusRound,
  loadConsensusDraftEvidence,
  loadConsensusDraftFailureReasons,
  loadConsensusVerdictCell,
  loadConsensusVerdicts,
  recordConsensusVerdict,
  type ConsensusDraftEvidence,
  type ConsensusVerdictEvidence,
} from "./ledger";
import {
  ConsensusGenerationPending,
  consensusSynthesisOwner,
  consensusVerifierOwner,
  loadConsensusSynthesis,
  type ConsensusSynthesisEvidence,
} from "./prompt-owner";
import {
  boundConsensusText,
  CONSENSUS_PROMPT_TEXT_CAP_BYTES,
  type ConsensusTextBounds,
} from "./text";

import { ensureSubstepRunSession } from "@/lib/runs/substep-session";
import { createHitlRequest } from "@/lib/runs/hitl-create";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { runAgentStep } from "@/lib/flows/runner-agent";
import { renderStrict } from "@/lib/flows/templating";
import { FlowPromptContinuationPending } from "@/lib/flows/graph/prompt-owner";
import { MaisterError } from "@/lib/errors";
import { isFencedError } from "@/lib/execution-host";
import { atomicWriteJson } from "@/lib/atomic";
import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import { artifactInstances } from "@/lib/db/schema";

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
  execution?: AgentExecution;
  bindExecution?: () => Promise<AgentExecution>;
  nodeAttemptId: string;
  nodeAttemptNumber: number;
  db: Db;
  // Independent root handle for work that outlives this traversal — the draft
  // children's dispatch. See ConsensusDraftLaunchInput.rootDb.
  rootDb: Db;
};

type ConsensusHumanDecision = {
  decision: string;
  resolution?: string;
};

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// ADR-166 E-EH-11: a verifier/synthesizer turn came back `assignment_fenced`
// — surface it as the same typed yield the graph runner already recognizes,
// so no verdict, artifact or node state is written by this generation.
function fencedYield(runId: string, nodeId: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    `consensus node ${nodeId} yielded — a newer driver generation owns run ${runId}`,
    { details: { reason: "assignment_fenced", runId } },
  );
}

function runDir(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): string {
  return path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

function boundedText(
  value: string,
  cap: number,
  role: string,
  participantId: string,
  round: number,
): string {
  const bounded = boundConsensusText(value, cap);

  if (bounded.truncated)
    log.warn(
      {
        role,
        participantId,
        round,
        bytes: bounded.bounds.bytes,
        cap: bounded.bounds.cap,
        droppedBytes: bounded.bounds.droppedBytes,
      },
      "consensus-text-truncated",
    );

  return bounded.text;
}

function promptText(
  value: string,
  role: string,
  participantId: string,
  round: number,
): string {
  return boundedText(
    value,
    CONSENSUS_PROMPT_TEXT_CAP_BYTES,
    role,
    participantId,
    round,
  );
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
  flowRevisionId: string | null;
  runDefaultRunnerId: string;
  runnerProfiles: ReturnType<typeof manifestRunnerProfiles>;
} {
  return {
    db: args.db,
    projectId: args.loaded.run.projectId,
    taskId: args.loaded.run.taskId,
    flowRevisionId: args.loaded.run.flowRevisionId ?? null,
    runDefaultRunnerId: args.loaded.runner.id,
    runnerProfiles: manifestRunnerProfiles(args),
  };
}

function manifestRunnerProfiles(args: RunConsensusNodeInput) {
  return args.loaded.manifest.runner_profiles;
}

function resolveVerifierRuntime(
  args: RunConsensusNodeInput & { verifierId: string },
): Promise<ConsensusRoleRuntime> {
  return resolveConsensusRoleRuntime({
    ...consensusRoleCtx(args),
    slotKey: `consensus:${args.node.id}:${args.verifierId}`,
    role: participantById(args.def, args.verifierId),
    roleLabel: `consensus verifier participant "${args.verifierId}"`,
  });
}

function resolveSynthesizerRuntime(
  args: RunConsensusNodeInput,
): Promise<ConsensusRoleRuntime> {
  return resolveConsensusRoleRuntime({
    ...consensusRoleCtx(args),
    slotKey: `consensus:${args.node.id}:synthesizer`,
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

function draftAvailable(draft: ConsensusDraftEvidence): boolean {
  return !!draft.artifactText?.trim();
}

// A settled round in which no participant produced a draft is an
// infrastructure failure, not a disagreement: verifying fail-closed over
// nothing, spending another round on nothing and then asking a human to pick
// between empty drafts would hide the real error. The node fails with the
// children's terminal evidence instead.
async function noDraftAvailableError(
  args: RunConsensusNodeInput & {
    round: number;
    drafts: readonly ConsensusDraftEvidence[];
  },
): Promise<MaisterError> {
  const reasons = await loadConsensusDraftFailureReasons({
    db: args.db,
    runIds: args.drafts.map((draft) => draft.runId),
  });
  const drafts = args.drafts.map((draft) => ({
    participantId: draft.participantId,
    runId: draft.runId,
    status: draft.status,
    reason: reasons[draft.runId] ?? null,
  }));
  const summary = drafts
    .map(
      (draft) =>
        `${draft.participantId} (run ${draft.runId}) ${draft.status}` +
        (draft.reason ? ` — ${draft.reason}` : ""),
    )
    .join("; ");

  log.error(
    {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      round: args.round,
      drafts,
    },
    "consensus round produced no available draft — failing the node",
  );

  return new MaisterError(
    "CRASH",
    `consensus node ${args.node.id} round ${args.round} produced no available draft: ${summary}`,
    {
      details: {
        reason: "consensus_no_draft_available",
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        round: args.round,
        drafts,
      },
    },
  );
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

// The author's prompt is rendered against the parent run's context (strict,
// like action.prompt) by the hop that needs it — the launching hop for the
// drafters, the synthesis hop for the synthesizer — and the two renders agree
// because nothing between them writes to the context (the verifier records no
// step). Either way the result is consumed as TEXT (draft body) or as a template
// VALUE (synthesis), never re-parsed, so a `{{ }}` in the task text can never
// fail a later hop.
function renderedNodePrompt(args: RunConsensusNodeInput): string {
  return renderStrict(
    args.def.prompt,
    args.context as unknown as Record<string, unknown>,
    { traceLog: log },
  );
}

// Agent-authored text (draft excerpts, verdict claims, the debate ledger, a
// human resolution) reaches the verifier and synthesizer prompts ONLY as
// template values under `consensus.*`. runAgentStep renders every prompt through
// renderStrict; a value is inserted, never re-parsed, so Mustache braces inside
// a draft cannot fail the node. Splicing that text into the template string is
// the bug this helper exists to make impossible.
export function withConsensusVars(
  context: FlowContext,
  vars: Record<string, string>,
): FlowContext {
  return { ...context, consensus: vars };
}

function draftPrompt(args: {
  context: FlowContext;
  basePrompt: string;
  critique: string | null;
}): string {
  return renderStrict(
    args.critique === null
      ? "{{ consensus.base }}\n\n{{ consensus.trailer }}"
      : "{{ consensus.base }}\n\n{{ consensus.critique }}\n\n{{ consensus.trailer }}",
    withConsensusVars(args.context, {
      base: args.basePrompt,
      critique: args.critique ?? "",
      trailer: consensusDraftTrailer(),
    }) as unknown as Record<string, unknown>,
    { traceLog: log },
  );
}

async function launchRound(
  args: RunConsensusNodeInput & {
    round: number;
  },
): Promise<ConsensusNodeResult> {
  const priorRound = args.round - 1;
  const priorDrafts =
    priorRound > 0
      ? await loadConsensusDraftEvidence({
          db: args.db,
          parentRunId: args.loaded.run.id,
          nodeAttemptId: args.nodeAttemptId,
          round: priorRound,
        })
      : [];
  const priorVerdicts =
    priorRound > 0
      ? await loadConsensusVerdicts({
          db: args.db,
          nodeAttemptId: args.nodeAttemptId,
          round: priorRound,
        })
      : [];
  const critique =
    priorRound > 0
      ? composeConsensusRoundCritique({
          round: priorRound,
          participants: participantOrder(args.def),
          drafts: priorDrafts,
          verdicts: priorVerdicts,
          axes: args.def.material_axes,
        })
      : null;
  const basePrompt = renderedNodePrompt(args);
  const prompts = args.def.participants.map((participant) => ({
    participantId: participant.id,
    prompt: draftPrompt({
      context: args.context,
      basePrompt,
      critique: critique?.participantPrompts.get(participant.id) ?? null,
    }),
  }));
  const draftRuns = await launchConsensusDraftRuns({
    db: args.db,
    rootDb: args.rootDb,
    projectId: args.loaded.run.projectId,
    taskId: args.loaded.run.taskId,
    flowRevisionId: args.loaded.run.flowRevisionId ?? null,
    runDefaultRunnerId: args.loaded.runner.id,
    runnerProfiles: args.loaded.manifest.runner_profiles,
    parentRunId: args.loaded.run.id,
    rootRunId: args.loaded.run.rootRunId ?? args.loaded.run.id,
    nodeId: args.node.id,
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
    prompts,
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

// A template, not a string, and deliberately argument-free: every dynamic part
// is a `consensus.*` value (see withConsensusVars), so there is no parameter
// through which the draft excerpt could be spliced into the template.
export function verifierPrompt(): string {
  return [
    "You are a consensus verifier. Audit the target draft against every material axis.",
    "Verifier id: {{ consensus.verifier_id }}",
    "Target participant id: {{ consensus.target_participant_id }}",
    "",
    "Material axes:",
    "{{ consensus.material_axes }}",
    "",
    "Target draft excerpt:",
    "{{ consensus.target_draft }}",
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
    sessionName: string;
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
  let parsed: ParsedConsensusVerdict | null = null;
  let applied: ConsensusVerdictEvidence | null = null;
  let errorCode: string | undefined;
  let verifierRuntime: ConsensusRoleRuntime | null = null;
  const owner = consensusVerifierOwner({
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
    verifierId: args.verifierId,
    targetParticipantId: args.target.participantId,
  });

  try {
    if (
      args.target.classification !== "complete" ||
      !args.target.artifactText
    ) {
      parsed = failClosedVerdict(args.def.material_axes);
      errorCode =
        args.target.classification === "partial"
          ? "draft_partial"
          : "draft_unavailable";
    } else {
      verifierRuntime = await resolveVerifierRuntime(args);
      // The verifier runs its own session beside the node's, deliberately on a
      // DIFFERENT runner — seed its row before the create ack so the runner is
      // recorded rather than left NULL (lib/runs/substep-session.ts).
      await ensureSubstepRunSession({
        db: args.db,
        runId: args.loaded.run.id,
        sessionName: args.sessionName,
        snapshot: verifierRuntime.resolution.runnerSnapshot,
        runnerId: verifierRuntime.resolution.runnerId,
        runnerResolutionTier: verifierRuntime.resolution.runnerResolutionTier,
        resolutionSource: verifierRuntime.resolutionSource,
        resolutionWarning: verifierRuntime.resolution.resolutionWarning ?? null,
      });
      const boundedTarget = boundConsensusText(
        args.target.artifactText,
        CONSENSUS_PROMPT_TEXT_CAP_BYTES,
      );
      const verifierContext = withConsensusVars(args.context, {
        verifier_id: args.verifierId,
        target_participant_id: args.target.participantId,
        material_axes: JSON.stringify(args.def.material_axes),
        target_draft: promptText(
          args.target.artifactText,
          "verifier",
          args.target.participantId,
          args.round,
        ),
      });

      await prepareConsensusInputEvidence(args.db, {
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        nodeAttemptId: args.nodeAttemptId,
        attempt: args.nodeAttemptNumber,
        round: args.round,
        generationId: owner.verdictId,
        role: "verifier",
        sourceId: args.target.artifactId ?? args.target.runId,
        value: boundedTarget.text,
        renderedPrompt: renderStrict(
          verifierPrompt(),
          verifierContext as unknown as Record<string, unknown>,
        ),
        textBounds: boundedTarget.bounds,
      });
      const res = await runAgentStep(
        {
          id: `${args.node.id}:verify:${args.round}:${args.verifierId}:${args.target.participantId}`,
          type: "agent",
          mode: "new-session",
          prompt: verifierPrompt(),
        },
        {
          promptOwner: owner,
          runtimeRoot: args.runtimeRoot,
          projectSlug: args.loaded.projectSlug,
          runId: args.loaded.run.id,
          stepId: `${args.node.id}-verify`,
          sessionName: args.sessionName,
          nodeAttemptId: args.nodeAttemptId,
          worktreePath: args.worktreePath,
          bindExecution: args.bindExecution,
          executor: {
            id: verifierRuntime.executor.id,
            agent: verifierRuntime.executor.agent,
            model: verifierRuntime.executor.model,
            env: (verifierRuntime.executor.env ?? undefined) as
              | Record<string, string>
              | undefined,
          },
          ...(verifierRuntime.runner ? { runner: verifierRuntime.runner } : {}),
          ...(verifierRuntime.adapterLaunch
            ? { adapterLaunch: verifierRuntime.adapterLaunch }
            : {}),
          ...(verifierRuntime.agentBinding
            ? { agentBinding: verifierRuntime.agentBinding }
            : {}),
          db: args.db,
          context: verifierContext,
        },
        args.execution,
      );

      if (res.fenced) throw fencedYield(args.loaded.run.id, args.node.id);
      // The owner already committed this cell from the verified command output.
      applied = await loadConsensusVerdictCell({
        db: args.db,
        nodeAttemptId: args.nodeAttemptId,
        round: args.round,
        verifierId: args.verifierId,
        targetParticipantId: args.target.participantId,
      });
      if (!applied) throw new ConsensusGenerationPending(owner.verdictId);
    }
  } catch (err) {
    if (
      isFencedError(err) ||
      err instanceof FlowPromptContinuationPending ||
      err instanceof ConsensusGenerationPending
    )
      throw err;
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

  const recorded =
    applied ??
    (await recordConsensusVerdict({
      db: args.db,
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      attempt: args.nodeAttemptNumber,
      round: args.round,
      verifierId: args.verifierId,
      targetParticipantId: args.target.participantId,
      result: parsed ?? failClosedVerdict(args.def.material_axes),
      rawOutput,
      ...(errorCode ? { errorCode } : {}),
    }));

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

  for (const [ordinal, assignment] of buildConsensusRotation(
    participantOrder(args.def),
  ).entries()) {
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

    if (target.classification !== "complete") {
      verdicts.push(
        await recordConsensusVerdict({
          db: args.db,
          runId: args.loaded.run.id,
          nodeId: args.node.id,
          nodeAttemptId: args.nodeAttemptId,
          attempt: args.nodeAttemptNumber,
          round: args.round,
          verifierId: assignment.verifierId,
          targetParticipantId: assignment.targetParticipantId,
          result: failClosedVerdict(args.def.material_axes),
          rawOutput:
            target.classification === "partial"
              ? `target draft partial: ${target.stopReason ?? "unknown"}`
              : "target draft unavailable",
          errorCode:
            target.classification === "partial"
              ? "draft_partial"
              : "draft_unavailable",
        }),
      );
      continue;
    }

    verdicts.push(
      await runVerifier({
        ...args,
        verifierId: assignment.verifierId,
        target,
        // Verifications run alongside the node's own live session and one after
        // another, so each takes a logical session of its own rather than
        // claiming (and serially re-claiming) the run's. Ordinal rather than the
        // id pair: the name is a path segment with a length budget.
        sessionName: `${args.node.id}-verify-${args.round}-${ordinal}`,
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
  return JSON.stringify(
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
  );
}

function promptDebateLogText(args: {
  source: string;
  round: number;
  tally: ConsensusTallyResult;
  verdicts: readonly ConsensusVerdictEvidence[];
  drafts: readonly ConsensusDraftEvidence[];
}): string {
  const shownVerdicts = args.verdicts.slice(0, 12);
  let remainingRows = 12;
  const verdicts = shownVerdicts.map((verdict) => {
    const rows = verdict.disagreements.slice(0, remainingRows);
    const shownAxes = Object.entries(verdict.axes).slice(0, 12);

    remainingRows -= rows.length;

    return {
      verifierId: verdict.verifierId,
      targetParticipantId: verdict.targetParticipantId,
      parseStatus: verdict.parseStatus,
      verdict: verdict.verdict,
      errorCode: verdict.errorCode,
      axes: Object.fromEntries(
        shownAxes.map(([axis, passed]) => [
          boundedText(
            axis,
            256,
            "debate-axis",
            verdict.targetParticipantId,
            args.round,
          ),
          passed,
        ]),
      ),
      omittedAxes: Object.keys(verdict.axes).length - shownAxes.length,
      disagreements: rows.map((row) => ({
        axis: boundedText(
          row.axis,
          256,
          "debate-axis",
          verdict.targetParticipantId,
          args.round,
        ),
        claim: boundedText(
          row.claim,
          1024,
          "debate-claim",
          verdict.targetParticipantId,
          args.round,
        ),
        counterEvidence: boundedText(
          row.counterEvidence,
          1024,
          "debate-counter-evidence",
          verdict.targetParticipantId,
          args.round,
        ),
      })),
      omittedRows: verdict.disagreements.length - rows.length,
      rawOutputArtifactId: verdict.rawOutputArtifactId,
    };
  });

  return JSON.stringify({
    source: args.source,
    round: args.round,
    tally: {
      agreementReached: args.tally.agreementReached,
      disagreementCount: args.tally.disagreementCount,
      invalidVerdictCount: args.tally.invalidVerdictCount,
      failedAxes: args.tally.failedAxes
        .slice(0, 12)
        .map((axis) =>
          boundedText(axis, 256, "debate-failed-axis", "all", args.round),
        ),
      omittedFailedAxes: Math.max(0, args.tally.failedAxes.length - 12),
    },
    draftRefs: args.drafts.map((draft) => ({
      participantId: draft.participantId,
      runId: draft.runId,
      artifactId: draft.artifactId,
      classification: draft.classification,
    })),
    verdicts,
    omittedVerdicts: args.verdicts.length - shownVerdicts.length,
  });
}

// A template, not a string, and deliberately argument-free: the rendered node
// prompt, the agreed material and the debate ledger are `consensus.*` values
// (see withConsensusVars), so neither the task text nor a draft is ever parsed
// as Mustache here.
export function synthesisPrompt(): string {
  return [
    "Synthesize the final consensus answer.",
    "Source: {{ consensus.source }}",
    "",
    "Original request:",
    "{{ consensus.prompt }}",
    "",
    "Selected or agreed material:",
    "{{ consensus.selected_text }}",
    "",
    "Debate ledger summary:",
    "{{ consensus.debate_log }}",
    "",
    "Return only the final plan text. Do not mention internal participant ids unless they are necessary for the answer.",
  ].join("\n");
}

function completedSynthesisText(
  evidence: ConsensusSynthesisEvidence,
  nodeId: string,
): string {
  if (evidence.kind === "incomplete" || evidence.text.trim().length === 0) {
    const stopReason =
      evidence.kind === "incomplete" ? evidence.stopReason : null;

    log.error(
      {
        nodeId,
        synthesisId: evidence.synthesisId,
        stopReason,
        reason: "consensus_synthesis_incomplete",
      },
      "consensus synthesis incomplete",
    );
    throw new MaisterError(
      "CRASH",
      `consensus synthesizer produced incomplete output for node ${nodeId}`,
      {
        details: {
          reason: "consensus_synthesis_incomplete",
          stopReason,
          synthesisId: evidence.synthesisId,
        },
      },
    );
  }

  return evidence.text;
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

  await ensureSubstepRunSession({
    db: args.db,
    runId: args.loaded.run.id,
    sessionName: `${args.node.id}-synthesize`,
    snapshot: synthesizer.resolution.runnerSnapshot,
    runnerId: synthesizer.resolution.runnerId,
    runnerResolutionTier: synthesizer.resolution.runnerResolutionTier,
    resolutionSource: synthesizer.resolutionSource,
    resolutionWarning: synthesizer.resolution.resolutionWarning ?? null,
  });

  const startedAt = Date.now();
  const debateLog = debateLogText(args);
  const owner = consensusSynthesisOwner({
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
    source: args.source,
  });
  // A parent stack that died after the paid turn re-enters on its own output.
  const applied = await loadConsensusSynthesis({
    db: args.db,
    synthesisId: owner.synthesisId,
  });

  if (applied !== null)
    return finishConsensusSynthesis({
      ...args,
      debateLog,
      planText: promptText(
        completedSynthesisText(applied, args.node.id),
        "plan",
        "synthesizer",
        args.round,
      ),
      planTextBounds: boundConsensusText(
        applied.text,
        CONSENSUS_PROMPT_TEXT_CAP_BYTES,
      ).truncated
        ? boundConsensusText(applied.text, CONSENSUS_PROMPT_TEXT_CAP_BYTES)
            .bounds
        : undefined,
      synthesisInputTextBounds: applied.inputTextBounds,
      synthesisTruncated: applied.truncated === true,
      startedAt,
      synthesizerRef: synthesizer.roleRef,
      synthesizerKind: synthesizer.roleKind,
    });
  const release = await acquireConsensusAgentCapacity({
    runId: args.loaded.run.id,
    nodeId: args.node.id,
    phase: "synthesize",
    actorId: synthesizer.roleRef,
  });
  let planText = "";
  let planTextBounds: ConsensusTextBounds | undefined;
  let synthesisInputTextBounds: ConsensusTextBounds | undefined;
  let synthesisTruncated = false;

  try {
    const boundedSelected = boundConsensusText(
      args.selectedText,
      CONSENSUS_PROMPT_TEXT_CAP_BYTES,
    );
    const synthesisContext = withConsensusVars(args.context, {
      source: args.source,
      prompt: renderedNodePrompt(args),
      selected_text: promptText(
        args.selectedText,
        "synthesis-input",
        "synthesizer",
        args.round,
      ),
      debate_log: promptDebateLogText(args),
    });

    await prepareConsensusInputEvidence(args.db, {
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      nodeAttemptId: args.nodeAttemptId,
      attempt: args.nodeAttemptNumber,
      round: args.round,
      generationId: owner.synthesisId,
      role: "synthesis",
      sourceId: args.source,
      value: boundedSelected.text,
      renderedPrompt: renderStrict(
        synthesisPrompt(),
        synthesisContext as unknown as Record<string, unknown>,
      ),
      textBounds: boundedSelected.bounds,
    });
    const res = await runAgentStep(
      {
        id: `${args.node.id}:synthesize`,
        type: "agent",
        mode: "new-session",
        prompt: synthesisPrompt(),
      },
      {
        promptOwner: owner,
        runtimeRoot: args.runtimeRoot,
        projectSlug: args.loaded.projectSlug,
        runId: args.loaded.run.id,
        stepId: `${args.node.id}-synthesize`,
        sessionName: `${args.node.id}-synthesize`,
        nodeAttemptId: args.nodeAttemptId,
        worktreePath: args.worktreePath,
        bindExecution: args.bindExecution,
        executor: {
          id: synthesizer.executor.id,
          agent: synthesizer.executor.agent,
          model: synthesizer.executor.model,
          env: (synthesizer.executor.env ?? undefined) as
            | Record<string, string>
            | undefined,
        },
        ...(synthesizer.runner ? { runner: synthesizer.runner } : {}),
        ...(synthesizer.adapterLaunch
          ? { adapterLaunch: synthesizer.adapterLaunch }
          : {}),
        ...(synthesizer.agentBinding
          ? { agentBinding: synthesizer.agentBinding }
          : {}),
        db: args.db,
        context: synthesisContext,
      },
      args.execution,
    );

    if (res.fenced) throw fencedYield(args.loaded.run.id, args.node.id);
    const output = await loadConsensusSynthesis({
      db: args.db,
      synthesisId: owner.synthesisId,
    });

    if (output === null)
      throw new ConsensusGenerationPending(owner.synthesisId);
    planText = promptText(
      completedSynthesisText(output, args.node.id),
      "plan",
      "synthesizer",
      args.round,
    );
    const boundedPlan = boundConsensusText(
      output.text,
      CONSENSUS_PROMPT_TEXT_CAP_BYTES,
    );

    planTextBounds = boundedPlan.truncated ? boundedPlan.bounds : undefined;
    synthesisInputTextBounds = output.inputTextBounds;
    synthesisTruncated = output.truncated === true;
  } finally {
    release();
  }

  return finishConsensusSynthesis({
    ...args,
    debateLog,
    planText,
    planTextBounds,
    synthesisInputTextBounds,
    synthesisTruncated,
    startedAt,
    synthesizerRef: synthesizer.roleRef,
    synthesizerKind: synthesizer.roleKind,
  });
}

async function finishConsensusSynthesis(
  args: RunConsensusNodeInput & {
    round: number;
    source: string;
    debateLog: string;
    planText: string;
    planTextBounds?: ConsensusTextBounds;
    synthesisInputTextBounds?: ConsensusTextBounds;
    synthesisTruncated: boolean;
    startedAt: number;
    synthesizerRef: string;
    synthesizerKind: "agent" | "runner";
  },
): Promise<ConsensusNodeResult> {
  const { debateLog, planText, startedAt } = args;

  if (planText.trim().length === 0)
    completedSynthesisText(
      {
        kind: "incomplete",
        text: planText,
        stopReason: null,
        synthesisId: consensusSynthesisOwner({
          nodeAttemptId: args.nodeAttemptId,
          round: args.round,
          source: args.source,
        }).synthesisId,
      },
      args.node.id,
    );

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
      locator: {
        kind: "inline",
        text: planText,
        ...(args.planTextBounds || args.synthesisTruncated
          ? { truncated: true }
          : {}),
        ...(args.planTextBounds ? { textBounds: args.planTextBounds } : {}),
        ...(args.synthesisInputTextBounds
          ? { inputTextBounds: args.synthesisInputTextBounds }
          : {}),
      },
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
      synthesizerId: args.synthesizerRef,
      synthesizerKind: args.synthesizerKind,
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
  nodeAttemptId: string;
  debateArtifactId: string;
  parentRunId: string;
  round: number;
  maxRounds: number;
  drafts: readonly ConsensusDraftEvidence[];
  tally: ConsensusTallyResult;
  debateLog: string;
  technicalFailures: readonly ConsensusTechnicalFailure[];
}): Record<string, unknown> {
  const choices = args.drafts.map((draft, index) => ({
    decision: `pick-draft-${index + 1}`,
    label: `Draft ${index + 1}`,
    artifactRef: draft.artifactId,
    artifactRunId: draft.runId,
    classification: draft.classification,
    stopReason: draft.stopReason,
    reason: draft.reason,
    excerpt: boundedText(
      draft.artifactText ?? "Draft unavailable.",
      CONSENSUS_TEXT_CAP_BYTES,
      "hitl-draft",
      draft.participantId,
      args.round,
    ),
  }));
  const allowedDecisions = [
    ...choices.map((choice) => choice.decision),
    "provide-resolution",
    ...(args.round < args.maxRounds ? ["re-run-round"] : []),
    "abort",
  ];

  return {
    kind: "consensus_resolution",
    nodeAttemptId: args.nodeAttemptId,
    round: args.round,
    maxRounds: args.maxRounds,
    allowedDecisions,
    drafts: choices,
    disagreements: args.tally.disagreements.slice(0, 24).map((item) => ({
      axis: item.axis,
      summary: item.claim,
    })),
    technicalFailures: args.technicalFailures,
    debateLog: {
      excerpt: boundedText(
        args.debateLog,
        CONSENSUS_TEXT_CAP_BYTES,
        "hitl-debate",
        "coordinator",
        args.round,
      ),
      artifactRef: args.debateArtifactId,
      artifactRunId: args.parentRunId,
    },
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
  const debateArtifactId = `run:${args.nodeAttemptId}:consensus-round-debate:${args.round}`;
  const schema = hitlSchema({
    nodeAttemptId: args.nodeAttemptId,
    debateArtifactId,
    parentRunId: args.loaded.run.id,
    round: args.round,
    maxRounds: args.maxRounds,
    drafts: args.drafts,
    tally: args.tally,
    debateLog,
    technicalFailures: technicalConsensusFailures(args.verdicts),
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
      await tx
        .insert(artifactInstances)
        .values({
          id: debateArtifactId,
          runId: args.loaded.run.id,
          nodeAttemptId: args.nodeAttemptId,
          nodeId: args.node.id,
          attempt: args.nodeAttemptNumber,
          artifactDefId: "consensus-round-debate",
          kind: "human_note",
          producer: "runner",
          locator: { kind: "inline", text: debateLog },
          validity: "current",
          requiredFor: ["review"],
          visibility: "internal",
          retention: "run",
        })
        .onConflictDoNothing();
      const [storedDebate] = await tx
        .select({ locator: artifactInstances.locator })
        .from(artifactInstances)
        .where(eq(artifactInstances.id, debateArtifactId));

      if (
        storedDebate?.locator.kind !== "inline" ||
        storedDebate.locator.text !== debateLog
      )
        throw new MaisterError(
          "CONFLICT",
          "consensus round debate changed on replay",
        );
      await createHitlRequest(tx, {
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

  return draft.classification === "partial"
    ? `Partial draft (stop reason: ${draft.stopReason ?? draft.reason ?? "unknown"}).\n\n${draft.artifactText}`
    : draft.artifactText;
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
  const humanRequest = humanDecision
    ? await resolveConsensusHumanRequest(args.db, {
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        nodeAttemptId: args.nodeAttemptId,
        ...humanDecision,
      })
    : null;
  const evidenceRound = humanRequest?.sourceRound ?? round;
  const drafts = orderedDrafts(
    args.def,
    await loadConsensusDraftEvidence({
      db: args.db,
      parentRunId: args.loaded.run.id,
      nodeAttemptId: args.nodeAttemptId,
      round: evidenceRound,
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
      if (!humanRequest)
        throw new MaisterError(
          "CONFLICT",
          "consensus rerun has no delivered request",
        );
      if (humanRequest.sourceRound >= maxRounds) {
        throw new MaisterError(
          "CONFLICT",
          `consensus node ${args.node.id} cannot re-run beyond round ${maxRounds}`,
        );
      }

      const intent = await prepareConsensusHumanIntent(args.db, {
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        nodeAttemptId: args.nodeAttemptId,
        attempt: args.nodeAttemptNumber,
        ...humanRequest,
      });
      const applied = await isConsensusHumanIntentApplied(args.db, intent);
      const result = applied
        ? {
            ok: true,
            stdout: "",
            vars: {},
            durationMs: 0,
            waitsForChildren: true,
          }
        : await launchRound({ ...args, round: intent.targetRound });

      if (!applied)
        await markConsensusHumanIntentApplied(args.db, {
          runId: args.loaded.run.id,
          nodeId: args.node.id,
          attempt: args.nodeAttemptNumber,
          intent,
        });

      await consumeConsensusHumanDecision({
        inputPath,
        runId: args.loaded.run.id,
        nodeId: args.node.id,
        decision: humanDecision.decision,
        round: humanRequest.sourceRound,
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
      round: evidenceRound,
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
        round: evidenceRound,
      }),
      drafts,
    });

    await consumeConsensusHumanDecision({
      inputPath,
      runId: args.loaded.run.id,
      nodeId: args.node.id,
      decision: humanDecision.decision,
      round: evidenceRound,
    });

    return result;
  }

  if (currentRound === 0 || !allDraftsSettled(args.def, drafts)) {
    return launchRound({ ...args, round });
  }

  if (!drafts.some(draftAvailable)) {
    throw await noDraftAvailableError({ ...args, round, drafts });
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

  if (
    args.def.rounds.mode === "iterate" &&
    round < maxRounds &&
    hasActionableConsensusCritique(verdicts, args.def.material_axes)
  ) {
    return launchRound({
      ...args,
      round: round + 1,
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
