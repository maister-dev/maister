import type { NodeDef } from "@/lib/config.schema";
import type { Db } from "@/lib/flows/graph/runner-core";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { resolveConsensusRunnerSnapshot } from "./roles";

import { launchAgentRun, startAgentSession } from "@/lib/agents/launch";
import * as schemaModule from "@/lib/db/schema";
import { type DelegationSnapshot } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertRunKindInvariant } from "@/lib/runs/run-kind-invariants";
import { tryStartRun } from "@/lib/scheduler";

const { runs } = schemaModule as unknown as Record<string, any>;

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
  projectId: string;
  taskId: string | null;
  parentRunId: string;
  rootRunId: string;
  nodeId: string;
  nodeAttemptId: string;
  round: number;
  prompt: string;
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
    participant: ConsensusParticipantDef & { runner: string },
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
): ConsensusDraftPayload {
  const kind = participantKind(participant);

  return {
    kind: "consensus_draft",
    nodeId: input.nodeId,
    nodeAttemptId: input.nodeAttemptId,
    round: input.round,
    participantId: participant.id,
    participantKind: kind,
    prompt: input.prompt,
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

  return {
    participantId,
    participantKind: payload.participantKind,
    runId: row.id,
    status: row.status,
  };
}

async function defaultCreateRunnerDraftRun(
  input: ConsensusDraftLaunchInput,
  participant: ConsensusParticipantDef & { runner: string },
  payload: ConsensusDraftPayload,
  runtime: ConsensusDraftRuntimeDeps = { startAgentSession, tryStartRun },
): Promise<ConsensusDraftLaunchResult> {
  const snapshot = await resolveConsensusRunnerSnapshot({
    db: input.db,
    runnerId: participant.runner,
    roleLabel: `consensus participant "${participant.id}"`,
  });
  const runId = randomUUID();
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
    agentId: null,
    triggerSource: "flow",
    triggerPayload: payload,
    agentWorkspace: payload.workspaceMode,
    taskId: input.taskId,
    projectId: input.projectId,
    flowId: null,
    runnerId: snapshot.id,
    runnerResolutionTier: "launchOverride",
    capabilityAgent: snapshot.capabilityAgent,
    runnerSnapshot: snapshot,
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

  await input.db.insert(runs).values(runRow);

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
        .startAgentSession(runId, { db: input.db })
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
  const launch = deps.launchAgent ?? launchAgentRun;
  const createRunnerDraftRun =
    deps.createRunnerDraftRun ?? defaultCreateRunnerDraftRun;
  const runtime = {
    startAgentSession: deps.startAgentSession ?? startAgentSession,
    tryStartRun: deps.tryStartRun ?? tryStartRun,
  };
  const results: ConsensusDraftLaunchResult[] = [];

  for (const participant of input.participants) {
    const existing = await existingDraftRun(input, participant.id);

    if (existing) {
      results.push(existing);
      continue;
    }

    const payload = draftPayload(input, participant);

    if ("agent" in participant && participant.agent) {
      const launched = await launch({
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
        db: input.db,
      });

      if ("deduped" in launched) {
        throw new MaisterError(
          "CONFLICT",
          `consensus agent participant "${participant.id}" unexpectedly deduped trigger ${launched.triggerEventId}`,
        );
      }

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
      runner: string;
    };

    results.push(
      await createRunnerDraftRun(input, runnerParticipant, payload, runtime),
    );
  }

  return results;
}
