import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type {
  FlowRunnerConfig,
  NodeDef,
  RunnerSlot,
} from "@/lib/config.schema";
import type { Db } from "@/lib/flows/graph/runner-core";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { resolveConsensusRunnerForParent } from "./roles";
import { prepareConsensusDraftAdmission } from "./admission";

import { defaultRunSessionValues } from "@/lib/acp-runners/resolve";
import {
  launchAgentRun,
  launchConsensusDraftAgentRun,
  startAgentSession,
} from "@/lib/agents/launch";
import * as schemaModule from "@/lib/db/schema";
import { type DelegationSnapshot } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertRunKindInvariant } from "@/lib/runs/run-kind-invariants";
import { tryStartRun } from "@/lib/scheduler";

const { runs, runSessions } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "consensus-drafts",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ConsensusNodeDef = Extract<NodeDef, { type: "consensus" }>;
export type ConsensusParticipantDef = ConsensusNodeDef["participants"][number];

export type ConsensusDraftPayload = {
  kind: "consensus_draft";
  nodeId: string;
  nodeAttemptId: string;
  round: number;
  participantId: string;
  participantKind: "agent" | "runner";
  prompt: string;
  workspaceMode: "repo_read";
};

export type ConsensusDraftLaunchInput = {
  db: Db;
  // The draft child outlives the parent's traversal: the coordinator parks and
  // releases its execution assignment right after fan-out, so every statement
  // on the traversal-scoped `db` then fails with FlowDriverClaimLost. The
  // child's dispatch (session create, prompt, finalization) rides this
  // independent root handle; only the fan-out's own rows stay on `db`.
  rootDb: Db;
  projectId: string;
  taskId: string | null;
  // M42 (ADR-114): binding context for portable consensus runner resolution.
  flowRevisionId: string | null;
  runDefaultRunnerId: string | null;
  runnerProfiles: Record<string, FlowRunnerConfig> | undefined;
  parentRunId: string;
  rootRunId: string;
  nodeId: string;
  nodeAttemptId: string;
  round: number;
  prompts: readonly Readonly<{ participantId: string; prompt: string }>[];
  participants: ConsensusParticipantDef[];
  workspaceMode: "repo_read";
};

export type ConsensusDraftLaunchResult = {
  participantId: string;
  participantKind: "agent" | "runner";
  runId: string;
  status: "Pending" | "Running" | "Done" | "Failed" | "Crashed";
};

type LaunchAgent = typeof launchAgentRun;

type ConsensusDraftDeps = {
  launchAgent?: LaunchAgent;
  startAgentSession?: typeof startAgentSession;
  tryStartRun?: typeof tryStartRun;
  createRunnerDraftRun?: (
    input: ConsensusDraftLaunchInput,
    participant: ConsensusParticipantDef & { runner: RunnerSlot },
    payload: ConsensusDraftPayload,
    runtime?: ConsensusDraftRuntimeDeps,
  ) => Promise<ConsensusDraftLaunchResult>;
};

type ConsensusDraftRuntimeDeps = {
  startAgentSession: typeof startAgentSession;
  tryStartRun: typeof tryStartRun;
};

function participantKind(
  participant: ConsensusParticipantDef,
): "agent" | "runner" {
  return "agent" in participant && participant.agent ? "agent" : "runner";
}

function participantWorkspaceMode(
  participant: ConsensusParticipantDef,
  nodeWorkspaceMode: "repo_read",
): "repo_read" {
  return participant.workspace?.mode ?? nodeWorkspaceMode;
}

function draftPayload(
  input: ConsensusDraftLaunchInput,
  participant: ConsensusParticipantDef,
  prompt: string,
): ConsensusDraftPayload {
  const kind = participantKind(participant);

  return {
    kind: "consensus_draft",
    nodeId: input.nodeId,
    nodeAttemptId: input.nodeAttemptId,
    round: input.round,
    participantId: participant.id,
    participantKind: kind,
    prompt,
    workspaceMode: participantWorkspaceMode(participant, input.workspaceMode),
  };
}

async function existingDraftRun(
  input: ConsensusDraftLaunchInput,
  participantId: string,
): Promise<ConsensusDraftLaunchResult | null> {
  const rows = await input.db
    .select({
      id: runs.id,
      status: runs.status,
      triggerPayload: runs.triggerPayload,
    })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, input.parentRunId),
        sql`${runs.triggerPayload}->>'kind' = 'consensus_draft'`,
        sql`${runs.triggerPayload}->>'nodeAttemptId' = ${input.nodeAttemptId}`,
        sql`${runs.triggerPayload}->>'participantId' = ${participantId}`,
        sql`${runs.triggerPayload}->>'round' = ${String(input.round)}`,
      ),
    );
  const row = rows[0];

  if (!row) return null;

  const payload = row.triggerPayload as ConsensusDraftPayload;
  const expectedPrompt = input.prompts.find(
    (item) => item.participantId === participantId,
  )?.prompt;

  if (payload.prompt !== expectedPrompt)
    throw new MaisterError(
      "CONFLICT",
      "Consensus draft request changed on replay",
      { details: { reason: "consensus_draft_prompt_changed" } },
    );

  return {
    participantId,
    participantKind: payload.participantKind,
    runId: row.id,
    status: row.status,
  };
}

// A consensus participant is a child of an already-admitted Flow run. Its
// runtime contract must therefore inherit the parent's immutable data-plane
// mode, rather than re-negotiating against a potentially changed host record.
async function executionDataPlaneModeForParent(
  input: ConsensusDraftLaunchInput,
): Promise<"canonical_events_v1"> {
  const rows = await input.db
    .select({ executionDataPlaneMode: runs.executionDataPlaneMode })
    .from(runs)
    .where(eq(runs.id, input.parentRunId));
  const mode = rows[0]?.executionDataPlaneMode;

  if (mode === "canonical_events_v1") {
    return mode;
  }

  throw new MaisterError(
    "PRECONDITION",
    `consensus parent run ${input.parentRunId} has no immutable data-plane mode`,
  );
}

async function defaultCreateRunnerDraftRun(
  input: ConsensusDraftLaunchInput,
  participant: ConsensusParticipantDef & { runner: RunnerSlot },
  payload: ConsensusDraftPayload,
  runtime: ConsensusDraftRuntimeDeps = { startAgentSession, tryStartRun },
): Promise<ConsensusDraftLaunchResult> {
  const resolved = await resolveConsensusRunnerForParent({
    db: input.db,
    parentRunId: input.parentRunId,
    slot: participant.runner,
    slotKey: `consensus:${input.nodeId}:${participant.id}`,
    projectId: input.projectId,
    flowRevisionId: input.flowRevisionId,
    runDefaultRunnerId: input.runDefaultRunnerId,
    runnerProfiles: input.runnerProfiles,
    roleLabel: `consensus participant "${participant.id}"`,
  });
  const snapshot = resolved.runnerSnapshot;
  const runId = randomUUID();
  const executionDataPlaneMode = await executionDataPlaneModeForParent(input);
  const allocated = await input.db.transaction(async (tx: ExecutionDb) => {
    await tx.execute(
      sql`SELECT id FROM runs WHERE id=${input.parentRunId} FOR UPDATE`,
    );
    await tx.execute(
      sql`SELECT id FROM node_attempts WHERE id=${input.nodeAttemptId} FOR UPDATE`,
    );
    const existing = await existingDraftRun(
      { ...input, db: tx },
      participant.id,
    );

    if (existing) return { existing };
    const admission =
      input.taskId === null
        ? null
        : await prepareConsensusDraftAdmission(tx, {
            parentRunId: input.parentRunId,
            rootRunId: input.rootRunId,
            taskId: input.taskId,
            projectId: input.projectId,
            nodeId: input.nodeId,
            nodeAttemptId: input.nodeAttemptId,
            round: input.round,
            participantId: participant.id,
            participantKind: "runner",
            runnerId: snapshot.id,
            agentId: null,
            prompt: payload.prompt,
          });
    const delegationSnapshot = {
      kind: "runner",
      runnerId: snapshot.id,
      participantId: participant.id,
      nodeId: input.nodeId,
      nodeAttemptId: input.nodeAttemptId,
      round: input.round,
      workspaceMode: payload.workspaceMode,
    } satisfies DelegationSnapshot;

    const runRow = {
      id: runId,
      runKind: "agent",
      executionDataPlaneMode,
      ...(admission ? { taskAdmissionSnapshot: admission.snapshot } : {}),
      agentId: null,
      triggerSource: "flow",
      triggerPayload: payload,
      agentWorkspace: payload.workspaceMode,
      taskId: input.taskId,
      projectId: input.projectId,
      flowId: null,
      // M42 (ADR-114): runner identity lives on `run_sessions` (inserted below).
      status: "Pending",
      currentStepId: "consensus-draft",
      flowVersion: "agent",
      flowRevision: "manual",
      parentRunId: input.parentRunId,
      rootRunId: input.rootRunId,
      launchMode: "manual",
      delegationSnapshot,
      persistent: false,
      workspaceMode: "own",
    };

    assertRunKindInvariant({
      id: runId,
      runKind: "agent",
      taskId: runRow.taskId,
      flowId: runRow.flowId,
      flowRevisionId: null,
      flowVersion: runRow.flowVersion,
      flowRevision: runRow.flowRevision,
      agentId: runRow.agentId,
      delegationSnapshot: runRow.delegationSnapshot,
    });

    await tx.insert(runs).values(runRow);
    // M42 (ADR-114): a consensus draft child is a single-`default`-session agent run.
    await tx.insert(runSessions).values({
      id: randomUUID(),
      ...defaultRunSessionValues(runId, resolved),
    });

    return { created: true as const };
  });

  if (allocated.existing) return allocated.existing;

  const startResult = await runtime.tryStartRun(runId, { db: input.db });

  log.info(
    {
      runId,
      parentRunId: input.parentRunId,
      nodeId: input.nodeId,
      nodeAttemptId: input.nodeAttemptId,
      round: input.round,
      participantId: participant.id,
      runnerId: snapshot.id,
      workspaceMode: payload.workspaceMode,
      started: startResult.started,
    },
    "consensus runner draft row launched",
  );

  if (startResult.started) {
    queueMicrotask(() => {
      void runtime
        .startAgentSession(runId, { db: input.rootDb })
        .catch((err: unknown) => {
          log.error(
            { runId, err: err instanceof Error ? err.message : String(err) },
            "consensus runner draft dispatch threw",
          );
        });
    });
  }

  return {
    participantId: participant.id,
    participantKind: "runner",
    runId,
    status: startResult.started ? "Running" : "Pending",
  };
}

export async function launchConsensusDraftRuns(
  input: ConsensusDraftLaunchInput,
  deps: ConsensusDraftDeps = {},
): Promise<ConsensusDraftLaunchResult[]> {
  const createRunnerDraftRun =
    deps.createRunnerDraftRun ?? defaultCreateRunnerDraftRun;
  const runtime = {
    startAgentSession: deps.startAgentSession ?? startAgentSession,
    tryStartRun: deps.tryStartRun ?? tryStartRun,
  };
  const results: ConsensusDraftLaunchResult[] = [];
  const configured = new Set(
    input.participants.map((participant) => participant.id),
  );
  const promptByParticipant = new Map<string, string>();

  for (const item of input.prompts) {
    if (
      !configured.has(item.participantId) ||
      promptByParticipant.has(item.participantId)
    )
      throw new MaisterError(
        "CRASH",
        `consensus draft prompt map contains a foreign or duplicate participant ${item.participantId}`,
        { details: { reason: "consensus_draft_prompt_map_invalid" } },
      );
    promptByParticipant.set(item.participantId, item.prompt);
  }
  if (promptByParticipant.size !== input.participants.length)
    throw new MaisterError(
      "CRASH",
      `consensus draft prompt map has ${promptByParticipant.size} prompts for ${input.participants.length} participants`,
      { details: { reason: "consensus_draft_prompt_map_invalid" } },
    );

  for (const participant of input.participants) {
    const existing = await existingDraftRun(input, participant.id);

    if (existing) {
      results.push(existing);
      continue;
    }

    const payload = draftPayload(
      input,
      participant,
      promptByParticipant.get(participant.id)!,
    );

    if ("agent" in participant && participant.agent) {
      const admission =
        input.taskId === null
          ? null
          : await prepareConsensusDraftAdmission(input.db, {
              parentRunId: input.parentRunId,
              rootRunId: input.rootRunId,
              taskId: input.taskId,
              projectId: input.projectId,
              nodeId: input.nodeId,
              nodeAttemptId: input.nodeAttemptId,
              round: input.round,
              participantId: participant.id,
              participantKind: "agent",
              runnerId: null,
              agentId: participant.agent,
              prompt: payload.prompt,
            });
      const target: Parameters<LaunchAgent>[0] = {
        agentId: participant.agent,
        projectId: input.projectId,
        taskId: input.taskId,
        trigger: {
          source: "flow",
          payload,
        },
        parentRunId: input.parentRunId,
        rootRunId: input.rootRunId,
        launchMode: "manual",
        workspaceMode: "own",
        workspace: payload.workspaceMode,
        ...(admission
          ? { launchOverrideRunnerId: admission.snapshot.parent.runnerId }
          : {}),
        db: input.db,
      };
      const launched = deps.launchAgent
        ? await deps.launchAgent(target)
        : admission
          ? await launchConsensusDraftAgentRun(target, admission, input.rootDb)
          : await launchAgentRun(target);

      if ("deduped" in launched) {
        const winner = await existingDraftRun(input, participant.id);

        if (winner) {
          results.push(winner);
          continue;
        }
        throw new MaisterError(
          "CONFLICT",
          `consensus agent participant "${participant.id}" unexpectedly deduped trigger ${launched.triggerEventId}`,
        );
      }
      if ("queued" in launched)
        throw new MaisterError(
          "PRECONDITION",
          "Consensus participant requires a parent-derived child Run, not a root launch intent",
          { details: { reason: "consensus_child_run_required" } },
        );

      results.push({
        participantId: participant.id,
        participantKind: "agent",
        runId: launched.runId,
        status: launched.status,
      });
      continue;
    }

    if (!("runner" in participant) || !participant.runner) {
      throw new MaisterError(
        "CONFIG",
        `consensus participant "${participant.id}" must declare agent or runner`,
      );
    }

    const runnerParticipant = participant as ConsensusParticipantDef & {
      runner: RunnerSlot;
    };

    results.push(
      await createRunnerDraftRun(input, runnerParticipant, payload, runtime),
    );
  }

  return results;
}
