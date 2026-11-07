import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient, ExecutionHosts } from "@/lib/execution-host";
import type { SessionCreateOwner } from "@/lib/execution-host/create-owner-contract";
import type { ActiveRunSession } from "@/lib/runs/active-run-session";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import {
  executionCommands,
  gateResults,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import {
  readCreateIntent,
  lockCreateOwner,
} from "@/lib/execution-host/create-intent";
import { MaisterError } from "@/lib/errors";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";

async function resumeCreateOwner(
  db: Db,
  client: BoundClient,
  active: ActiveRunSession,
  stepId: string,
): Promise<SessionCreateOwner> {
  const [original] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, client.assignment.runId),
        eq(executionCommands.executionAssignmentId, client.assignment.id),
        eq(executionCommands.kind, "session.create"),
        isNotNull(executionCommands.createIntent),
      ),
    )
    .orderBy(desc(executionCommands.createdAt), desc(executionCommands.id))
    .limit(1);

  if (original)
    return readCreateIntent(original, client.host.hostKey).intent.owner;
  const [attempt] = await db
    .select()
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, client.assignment.runId),
        eq(nodeAttempts.nodeId, stepId),
        eq(nodeAttempts.executionAssignmentId, client.assignment.id),
      ),
    )
    .orderBy(desc(nodeAttempts.startedAt), desc(nodeAttempts.id))
    .limit(1);
  const candidates: SessionCreateOwner[] = [];

  if (attempt) {
    candidates.push({
      variant: "node",
      nodeAttemptId: attempt.id,
      promptOrdinal: attempt.actionPromptOrdinal,
    });
    const [gate] = await db
      .select()
      .from(gateResults)
      .where(
        and(
          eq(gateResults.nodeAttemptId, attempt.id),
          eq(gateResults.status, "running"),
          inArray(gateResults.kind, ["ai_judgment", "skill_check"]),
        ),
      )
      .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
      .limit(1);

    if (gate)
      candidates.unshift({
        variant: gate.kind === "ai_judgment" ? "gate_ai" : "gate_skill",
        nodeAttemptId: attempt.id,
        gateId: gate.gateId,
        evaluationId: gate.id,
      });
  }
  for (const owner of candidates) {
    const current = await db.transaction((tx: Db) =>
      lockCreateOwner(
        tx,
        {
          runId: client.assignment.runId,
          assignmentId: client.assignment.id,
          owner,
        },
        "create",
      ),
    );

    if (current) return owner;
  }
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, client.assignment.runId));
  const [source] = await db
    .select()
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, client.assignment.runId),
        eq(runSessionIncarnations.runSessionId, active.id),
        inArray(runSessionIncarnations.state, ["checkpointed", "lost"]),
      ),
    )
    .orderBy(
      desc(runSessionIncarnations.assignmentEpoch),
      desc(runSessionIncarnations.createdAt),
    )
    .limit(1);

  if (!source || (run?.runKind !== "flow" && run?.runKind !== "scratch"))
    throw new MaisterError(
      "PRECONDITION",
      "Resume needs the original checkpointed session evidence; reconcile the original host",
      {
        details: { reason: "resume_create_source_unproven" },
      },
    );

  const owner: SessionCreateOwner = {
    variant: run.runKind === "flow" ? "flow_resume" : "scratch_resume",
    runSessionId: active.id,
    sourceIncarnationId: source.id,
  };
  const current = await db.transaction((tx: Db) =>
    lockCreateOwner(
      tx,
      {
        runId: client.assignment.runId,
        assignmentId: client.assignment.id,
        owner,
      },
      "create",
    ),
  );

  if (!current)
    throw new MaisterError(
      "PRECONDITION",
      "Resume source retirement is unproven; reconcile the original host",
      {
        details: { reason: "resume_create_source_unproven" },
      },
    );

  return owner;
}

/** Continue the current resume generation; the owned engine loads original bytes first. */
export async function continueResumeSessionCreate(args: {
  runId: string;
  assignmentId: string | null;
  db: Db;
  executionHosts: ExecutionHosts;
}): Promise<{
  sessionId: string;
  acpSessionId: string;
}> {
  const { client } = await args.executionHosts.executionFor(args.runId, {
    assignmentId: args.assignmentId,
  });
  const active = await loadActiveRunSession(args.db, args.runId);
  const [run] = await args.db
    .select()
    .from(runs)
    .where(eq(runs.id, args.runId));

  if (!active?.acpSessionId || !active.runnerSnapshot || !run)
    throw new MaisterError(
      "PRECONDITION",
      "Resume's original logical session is unavailable",
      {
        details: { reason: "resume_create_source_unproven" },
      },
    );
  const owner = await resumeCreateOwner(
    args.db,
    client,
    active,
    run.currentStepId ?? "resume",
  );
  const snapshot = active.runnerSnapshot;
  const resumeSessionId = active.acpSessionId;
  const result = await client.createOwnedSession(owner, async () => ({
    stepId: run.currentStepId ?? "resume",
    sessionName: active.sessionName,
    executor: runnerExecutorInput(snapshot),
    runner: runnerSupervisorInput({ snapshot }),
    resumeSessionId,
    adapterLaunch: mergeRunnerAdapterLaunch(snapshot),
  }));

  return { sessionId: result.sessionId, acpSessionId: result.acpSessionId };
}
