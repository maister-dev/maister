import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { resolveConsensusRunnerForParent } from "./roles";
import { resolveConsensusHumanRequest } from "./human-decision";

import {
  runs,
  runSessions,
  nodeAttempts,
  flowRevisions,
  artifactInstances,
} from "@/lib/db/schema";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { parentAdmissionDigest } from "@/lib/tasks/qualification-admission";
import { taskLaunchInputForRun } from "@/lib/tasks/launch-execution-input";
import { retryDigest } from "@/lib/agents/retry-guards";
import { resolveAgentLaunchRuntime } from "@/lib/agents/launch";
import { MaisterError } from "@/lib/errors";

const identifier = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const consensusDraftAdmissionSchema = z
  .object({
    version: z.literal(3),
    policyVersion: z.literal(3),
    mode: z.literal("execution_child"),
    basis: z.literal("execution_child"),
    scope: z.literal("consensus_draft"),
    inputRevision: z.number().int().positive(),
    parent: z
      .object({
        parentRunId: identifier,
        parentTaskId: identifier.nullable(),
        rootRunId: identifier,
        parentAdmissionDigest: digest,
        nodeAttemptId: identifier,
        nodeId: identifier,
        round: z.number().int().positive(),
        participantId: identifier,
        participantKind: z.enum(["agent", "runner"]),
        runnerId: identifier,
        agentId: identifier.nullable(),
        promptDigest: digest,
        manifestDigest: digest,
      })
      .strict(),
  })
  .strict();
export type ConsensusDraftAdmissionSnapshot = z.infer<
  typeof consensusDraftAdmissionSchema
>;
const consensusDraftAuthority = Symbol("parent consensus attempt admission");

export type ConsensusDraftAdmission = Readonly<{
  [consensusDraftAuthority]: true;
  snapshot: ConsensusDraftAdmissionSnapshot;
}>;

export function assertPreparedConsensusDraftAdmission(
  value: ConsensusDraftAdmission,
): void {
  if (value?.[consensusDraftAuthority] !== true)
    throw refusal("consensus_parent_authority_required");
}
function refusal(reason: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Consensus draft requires its current admitted parent node",
    { details: { reason } },
  );
}

async function currentParent(
  db: Db,
  parentRunId: string,
  nodeId: string,
  nodeAttemptId: string,
) {
  const [parent] = await db.select().from(runs).where(eq(runs.id, parentRunId));

  if (
    !parent ||
    parent.agentKind === "operational" ||
    !parent.projectId ||
    !parent.flowRevisionId ||
    !parent.taskAdmissionSnapshot ||
    !["Running", "WaitingOnChildren"].includes(parent.status) ||
    parent.currentStepId !== nodeId
  )
    throw refusal("consensus_parent_unavailable");
  if (!(await taskLaunchInputForRun(db, parent)))
    throw refusal("consensus_parent_input_unavailable");
  const [attempt] = await db
    .select()
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, parentRunId), eq(nodeAttempts.nodeId, nodeId)),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1);

  if (
    !attempt ||
    attempt.id !== nodeAttemptId ||
    attempt.nodeType !== "consensus" ||
    !["Running", "NeedsInput"].includes(attempt.status)
  )
    throw refusal("consensus_parent_attempt_changed");
  const [revision] = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, parent.flowRevisionId));

  if (!revision) throw refusal("consensus_parent_manifest_missing");
  const manifest = parseExecutableStoredFlowManifest(revision.manifest, {
    code: "CONFIG",
    surface: "consensus-child-admission",
    manifestLabel: "parent pinned Flow manifest",
  });
  const node = manifest.nodes.find((candidate) => candidate.id === nodeId);

  if (node?.type !== "consensus")
    throw refusal("consensus_parent_attempt_changed");
  const [session] = await db
    .select({ runnerId: runSessions.runnerId })
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, parent.id),
        eq(runSessions.sessionName, "default"),
      ),
    );

  if (!session) throw refusal("consensus_parent_runner_missing");

  return {
    parent,
    admission: parent.taskAdmissionSnapshot,
    attempt,
    manifest,
    node,
    defaultRunnerId: session.runnerId,
  };
}

async function assertRound(
  db: Db,
  facts: Awaited<ReturnType<typeof currentParent>>,
  round: number,
): Promise<void> {
  const drafts = await db
    .select({ status: runs.status, payload: runs.triggerPayload })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, facts.parent.id),
        sql`${runs.triggerPayload}->>'kind'='consensus_draft'`,
        sql`${runs.triggerPayload}->>'nodeAttemptId'=${facts.attempt.id}`,
      ),
    );
  const rounds = drafts.map((row) =>
    typeof row.payload?.round === "number" ? row.payload.round : 0,
  );
  const latest = Math.max(0, ...rounds);

  const lastSettled = drafts
    .filter((row) => row.payload?.round === latest)
    .every((row) =>
      ["Done", "Failed", "Crashed", "Abandoned", "Review"].includes(row.status),
    );
  const limit =
    facts.node.rounds.mode === "single_pass" ? 1 : facts.node.rounds.max;

  if (round === Math.max(1, latest) && round <= limit) return;
  if (round === latest + 1 && latest > 0 && lastSettled && round <= limit)
    return;
  const humanIntents = await db
    .select({ locator: artifactInstances.locator })
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.runId, facts.parent.id),
        eq(artifactInstances.nodeAttemptId, facts.attempt.id),
        eq(artifactInstances.artifactDefId, "consensus-human-intent"),
        eq(artifactInstances.validity, "current"),
      ),
    );

  for (const row of humanIntents) {
    if (row.locator.kind !== "inline")
      throw refusal("consensus_human_intent_invalid");
    let value: unknown;

    try {
      value = JSON.parse(row.locator.text) as unknown;
    } catch (cause) {
      throw new MaisterError("CRASH", "Consensus human intent is invalid", {
        details: { reason: "consensus_human_intent_invalid" },
        cause,
      });
    }
    const intent = z
      .object({
        version: z.literal(1),
        nodeAttemptId: identifier,
        sourceRound: z.number().int().positive(),
        targetRound: z.number().int().positive(),
        decision: z.literal("re-run-round"),
        hitlRequestId: identifier,
        responseDigest: digest,
      })
      .strict()
      .safeParse(value);

    if (!intent.success) throw refusal("consensus_human_intent_invalid");
    if (
      intent.data.nodeAttemptId !== facts.attempt.id ||
      intent.data.targetRound !== round ||
      intent.data.sourceRound !== round - 1 ||
      !(latest === round || (latest === round - 1 && lastSettled))
    )
      continue;
    const delivered = await resolveConsensusHumanRequest(db, {
      runId: facts.parent.id,
      nodeId: facts.attempt.nodeId,
      nodeAttemptId: facts.attempt.id,
      decision: "re-run-round",
    });

    if (
      delivered.hitlRequestId !== intent.data.hitlRequestId ||
      delivered.sourceRound !== intent.data.sourceRound ||
      delivered.responseDigest !== intent.data.responseDigest
    )
      throw refusal("consensus_human_intent_invalid");

    return;
  }
  throw refusal("consensus_parent_round_changed");
}

/** Validate stored child proof again before first model dispatch; no caller's parent ID can replace it. */
export async function assertConsensusDraftAdmission(
  db: Db,
  value: ConsensusDraftAdmissionSnapshot,
  child?: Pick<
    Run,
    | "projectId"
    | "taskId"
    | "parentRunId"
    | "rootRunId"
    | "agentId"
    | "triggerPayload"
  > &
    Partial<Pick<Run, "id">>,
): Promise<void> {
  const parsed = consensusDraftAdmissionSchema.safeParse(value);

  if (!parsed.success) throw refusal("consensus_parent_snapshot_invalid");
  const snapshot = parsed.data;
  const proof = snapshot.parent;
  const facts = await currentParent(
    db,
    proof.parentRunId,
    proof.nodeId,
    proof.nodeAttemptId,
  );

  if (
    facts.parent.taskId !== proof.parentTaskId ||
    (facts.parent.rootRunId ?? facts.parent.id) !== proof.rootRunId ||
    parentAdmissionDigest(facts.parent) !== proof.parentAdmissionDigest ||
    facts.admission.inputRevision !== snapshot.inputRevision ||
    retryDigest(facts.manifest) !== proof.manifestDigest
  )
    throw refusal("consensus_parent_snapshot_changed");
  const participant = facts.node.participants.find(
    (candidate) => candidate.id === proof.participantId,
  );

  if (
    !participant ||
    (proof.participantKind === "agent"
      ? participant.agent !== proof.agentId
      : !participant.runner || proof.agentId !== null)
  )
    throw refusal("consensus_participant_changed");
  if (
    (await participantRunner(
      db,
      facts,
      proof.participantId,
      proof.participantKind,
      proof.agentId,
    )) !== proof.runnerId
  )
    throw refusal("consensus_participant_changed");
  await assertRound(db, facts, proof.round);
  if (child) {
    const payload = child.triggerPayload;

    if (
      child.projectId !== facts.parent.projectId ||
      child.taskId !== proof.parentTaskId ||
      child.parentRunId !== facts.parent.id ||
      child.rootRunId !== proof.rootRunId ||
      child.agentId !== proof.agentId ||
      payload?.kind !== "consensus_draft" ||
      payload.nodeId !== proof.nodeId ||
      payload.nodeAttemptId !== proof.nodeAttemptId ||
      payload.round !== proof.round ||
      payload.participantId !== proof.participantId ||
      payload.participantKind !== proof.participantKind ||
      typeof payload.prompt !== "string" ||
      retryDigest(payload.prompt) !== proof.promptDigest
    )
      throw refusal("consensus_child_scope_changed");
    if (child.id) {
      const [session] = await db
        .select({ runnerId: runSessions.runnerId })
        .from(runSessions)
        .where(
          and(
            eq(runSessions.runId, child.id),
            eq(runSessions.sessionName, "default"),
          ),
        );

      if (session?.runnerId !== proof.runnerId)
        throw refusal("consensus_participant_changed");
    }
  }
}

type ConsensusDraftAdmissionSelection = Readonly<{
  parentRunId: string;
  rootRunId: string;
  taskId: string | null;
  projectId: string;
  nodeId: string;
  nodeAttemptId: string;
  round: number;
  participantId: string;
  participantKind: "agent" | "runner";
  runnerId: string | null;
  agentId: string | null;
  prompt: string;
}>;

async function participantRunner(
  db: Db,
  facts: Awaited<ReturnType<typeof currentParent>>,
  participantId: string,
  kind: "agent" | "runner",
  agentId: string | null,
): Promise<string> {
  const participant = facts.node.participants.find(
    (candidate) => candidate.id === participantId,
  );

  if (!participant) throw refusal("consensus_participant_changed");
  if (kind === "agent") {
    if (!agentId || participant.agent !== agentId)
      throw refusal("consensus_participant_changed");
    const runtime = await resolveAgentLaunchRuntime({
      agentId,
      projectId: facts.parent.projectId!,
      taskId: facts.parent.taskId,
      workspace: "repo_read",
      parentRunId: facts.parent.id,
      rootRunId: facts.parent.rootRunId ?? facts.parent.id,
      trigger: { source: "flow" },
      db,
    });

    if (
      runtime.effective.parsed.kind !== "code_delivery" ||
      runtime.effective.parsed.flow
    )
      throw refusal("consensus_participant_target_unsupported");

    return runtime.resolution.runnerId;
  }
  if (!participant.runner || agentId !== null)
    throw refusal("consensus_participant_changed");

  return (
    await resolveConsensusRunnerForParent({
      db,
      parentRunId: facts.parent.id,
      slot: participant.runner,
      slotKey: `consensus:${facts.attempt.nodeId}:${participantId}`,
      projectId: facts.parent.projectId!,
      flowRevisionId: facts.parent.flowRevisionId,
      runDefaultRunnerId: facts.defaultRunnerId,
      runnerProfiles: facts.manifest.runner_profiles,
      roleLabel: `consensus participant ${participantId}`,
    })
  ).runnerId;
}

/** Only the current parent/attempt/manifest participant can mint this private child capability. */
export async function prepareConsensusDraftAdmission(
  db: Db,
  selection: ConsensusDraftAdmissionSelection,
): Promise<ConsensusDraftAdmission> {
  const facts = await currentParent(
    db,
    selection.parentRunId,
    selection.nodeId,
    selection.nodeAttemptId,
  );

  if (
    facts.parent.status !== "Running" ||
    facts.attempt.status !== "Running" ||
    facts.parent.projectId !== selection.projectId ||
    facts.parent.taskId !== selection.taskId ||
    (facts.parent.rootRunId ?? facts.parent.id) !== selection.rootRunId
  )
    throw refusal("consensus_parent_unavailable");
  const participant = facts.node.participants.find(
    (candidate) => candidate.id === selection.participantId,
  );

  if (
    !participant ||
    (selection.participantKind === "agent"
      ? participant.agent !== selection.agentId || !selection.agentId
      : !participant.runner || selection.agentId !== null)
  )
    throw refusal("consensus_participant_changed");
  const runnerId = await participantRunner(
    db,
    facts,
    selection.participantId,
    selection.participantKind,
    selection.agentId,
  );

  if (selection.runnerId !== null && selection.runnerId !== runnerId)
    throw refusal("consensus_participant_changed");
  const snapshot: ConsensusDraftAdmissionSnapshot = {
    version: 3,
    policyVersion: 3,
    mode: "execution_child",
    basis: "execution_child",
    scope: "consensus_draft",
    inputRevision: facts.admission.inputRevision,
    parent: {
      parentRunId: facts.parent.id,
      parentTaskId: facts.parent.taskId,
      rootRunId: selection.rootRunId,
      parentAdmissionDigest: parentAdmissionDigest(facts.parent),
      nodeAttemptId: facts.attempt.id,
      nodeId: selection.nodeId,
      round: selection.round,
      participantId: selection.participantId,
      participantKind: selection.participantKind,
      runnerId,
      agentId: selection.agentId,
      promptDigest: retryDigest(selection.prompt),
      manifestDigest: retryDigest(facts.manifest),
    },
  };

  await assertConsensusDraftAdmission(db, snapshot);

  return { [consensusDraftAuthority]: true, snapshot };
}
