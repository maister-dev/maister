import "server-only";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { issueJudgeAttemptToken } from "@/lib/agents/tokens";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): schema-module bridge (matches lib/evaluations/config.ts).
const {
  evaluationExecutions,
  evaluationJudgeAttempts,
  evaluationMethodRevisions,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-judge-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

// The resolved panel binding for one logical judge role (D8). `agentId` is a
// package-qualified platform agent (`<packageName>:<stem>`); `count` is the
// independent attempt count for the role (method-declared).
interface ResolvedRole {
  role: string;
  agentId: string;
  runnerId: string | null;
  count: number;
}

// The spawn seam: launch one dedicated workspace:none agent Run for an attempt
// and mint its attempt-bound judge token. Injectable so the provisioning +
// duplicate-adoption logic is testable without a live agent; production wires the
// real agent launcher + MCP materialization (the supervisor delivers the judge
// token to the agent's evaluator-facade MCP config).
export interface JudgeSpawn {
  runId: string;
  tokenId: string;
}

export type JudgeSpawnFn = (args: {
  agentId: string;
  projectId: string;
  runnerId: string | null;
  executionId: string;
  attemptId: string;
  role: string;
  ordinal: number;
}) => Promise<JudgeSpawn>;

interface ExecutionForLaunch {
  id: string;
  studyId: string;
  status: string;
  methodRevisionId: string | null;
  judgePolicySnapshot: {
    roleBindings?: Array<{
      role: string;
      agentId: string;
      runnerId?: string | null;
    }>;
  } | null;
  projectId: string;
}

async function loadExecutionForLaunch(
  executionId: string,
  d: Db,
): Promise<ExecutionForLaunch> {
  const { evaluationStudies } = schemaModule as unknown as Record<string, any>;
  const [row] = (await d
    .select({
      id: evaluationExecutions.id,
      studyId: evaluationExecutions.studyId,
      status: evaluationExecutions.status,
      methodRevisionId: evaluationExecutions.methodRevisionId,
      judgePolicySnapshot: evaluationExecutions.judgePolicySnapshot,
      projectId: evaluationStudies.projectId,
    })
    .from(evaluationExecutions)
    .innerJoin(
      evaluationStudies,
      eq(evaluationExecutions.studyId, evaluationStudies.id),
    )
    .where(eq(evaluationExecutions.id, executionId))) as ExecutionForLaunch[];

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation execution not found: ${executionId}`,
    );
  }

  return row;
}

// Resolve the (role × ordinal) attempt matrix: each method judge role's declared
// count crossed with its panel-bound agent. A role with no panel binding is a
// CONFIG refusal (the panel is incomplete) — never a silently dropped role.
async function resolvePanel(
  exec: ExecutionForLaunch,
  d: Db,
): Promise<ResolvedRole[]> {
  if (!exec.methodRevisionId) {
    throw new MaisterError(
      "PRECONDITION",
      `execution ${exec.id} has no method revision`,
    );
  }

  const [rev] = await d
    .select({
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationMethodRevisions)
    .where(eq(evaluationMethodRevisions.id, exec.methodRevisionId));

  const roles = (rev?.normalizedDefinition?.definition?.judges?.roles ??
    []) as Array<{
    id: string;
    count: number;
  }>;
  const bindings = new Map(
    (exec.judgePolicySnapshot?.roleBindings ?? []).map((b) => [b.role, b]),
  );

  return roles.map((r) => {
    const binding = bindings.get(r.id);

    if (!binding) {
      throw new MaisterError(
        "CONFIG",
        `judge role "${r.id}" has no panel agent binding`,
      );
    }

    return {
      role: r.id,
      agentId: binding.agentId,
      runnerId: binding.runnerId ?? null,
      count: r.count,
    };
  });
}

// Provision the attempt matrix for an execution's panel (D12). Idempotent —
// each (execution, role, ordinal) is inserted with an ON CONFLICT DO NOTHING on
// the unique index (execution, role, ordinal, retry_ordinal=0), so a duplicate
// call adopts the existing rows rather than double-creating. Returns the current
// primary attempt rows (queued or already-launched).
export async function provisionJudgeAttempts(
  executionId: string,
  db?: Db,
): Promise<
  Array<{
    id: string;
    role: string;
    ordinal: number;
    agentId: string;
    runnerId: string | null;
    agentRunId: string | null;
    status: string;
  }>
> {
  const d = db ?? getDb();
  const exec = await loadExecutionForLaunch(executionId, d);
  const panel = await resolvePanel(exec, d);

  for (const r of panel) {
    for (let ordinal = 1; ordinal <= r.count; ordinal++) {
      await d
        .insert(evaluationJudgeAttempts)
        .values({
          executionId,
          role: r.role,
          ordinal,
          retryOrdinal: 0,
          agentId: r.agentId,
          status: "queued",
        })
        .onConflictDoNothing({
          target: [
            evaluationJudgeAttempts.executionId,
            evaluationJudgeAttempts.role,
            evaluationJudgeAttempts.ordinal,
            evaluationJudgeAttempts.retryOrdinal,
          ],
        });
    }
  }

  const rows = (await d
    .select({
      id: evaluationJudgeAttempts.id,
      role: evaluationJudgeAttempts.role,
      ordinal: evaluationJudgeAttempts.ordinal,
      agentId: evaluationJudgeAttempts.agentId,
      agentRunId: evaluationJudgeAttempts.agentRunId,
      status: evaluationJudgeAttempts.status,
    })
    .from(evaluationJudgeAttempts)
    .where(
      and(
        eq(evaluationJudgeAttempts.executionId, executionId),
        eq(evaluationJudgeAttempts.retryOrdinal, 0),
      ),
    )) as Array<{
    id: string;
    role: string;
    ordinal: number;
    agentId: string;
    agentRunId: string | null;
    status: string;
  }>;

  const byRole = new Map(panel.map((p) => [p.role, p]));

  return rows.map((r) => ({
    ...r,
    runnerId: byRole.get(r.role)?.runnerId ?? null,
  }));
}

// Launch the judge panel: provision the attempt matrix, then spawn a dedicated
// agent Run per not-yet-launched attempt (duplicate-launch adoption — an attempt
// that already carries an agentRunId is adopted, never re-spawned). Each spawn
// mints an attempt-bound judge token stored on the attempt row; the timeout clock
// anchors at Running, never at enqueue (D12). Returns the launched/adopted count.
export async function launchJudgePanel(
  executionId: string,
  deps: { spawn: JudgeSpawnFn },
  db?: Db,
): Promise<{ launched: number; adopted: number }> {
  const d = db ?? getDb();
  const exec = await loadExecutionForLaunch(executionId, d);

  if (exec.status !== "judging") {
    throw new MaisterError(
      "CONFLICT",
      `execution ${executionId} is ${exec.status}, not judging`,
    );
  }

  const attempts = await provisionJudgeAttempts(executionId, d);

  let launched = 0;
  let adopted = 0;

  for (const attempt of attempts) {
    if (attempt.agentRunId) {
      adopted++;
      continue;
    }

    const now = new Date();
    const spawn = await deps.spawn({
      agentId: attempt.agentId,
      projectId: exec.projectId,
      runnerId: attempt.runnerId,
      executionId,
      attemptId: attempt.id,
      role: attempt.role,
      ordinal: attempt.ordinal,
    });

    await d
      .update(evaluationJudgeAttempts)
      .set({
        agentRunId: spawn.runId,
        tokenId: spawn.tokenId,
        status: "running",
        enqueuedAt: now,
        // The attempt timeout clock anchors here (session Running), never at
        // enqueue — a cap-queued attempt never times out before it starts (D12).
        runningAt: now,
      })
      .where(eq(evaluationJudgeAttempts.id, attempt.id));

    launched++;
  }

  log.info({ executionId, launched, adopted }, "judge panel launched");

  return { launched, adopted };
}

// The default production spawn seam: a dedicated workspace:none agent Run per
// attempt with an attempt-bound judge token. The token→evaluator-facade MCP wiring
// is delivered by the supervisor at materialization; this returns the runId +
// tokenId the attempt row records for server-derived attribution.
export function defaultJudgeSpawn(db?: Db): JudgeSpawnFn {
  return async (args) => {
    const { launchAgentRun } = await import("@/lib/agents/launch");
    const result = await launchAgentRun({
      agentId: args.agentId,
      projectId: args.projectId,
      launchOverrideRunnerId: args.runnerId,
      trigger: { source: "manual" },
      workspace: "none",
      db,
    });

    if ("deduped" in result) {
      throw new MaisterError(
        "CONFLICT",
        `judge attempt ${args.attemptId} spawn deduped unexpectedly`,
      );
    }

    const token = await issueJudgeAttemptToken({
      agentId: args.agentId,
      projectId: args.projectId,
      runId: result.runId,
      db,
    });

    return { runId: result.runId, tokenId: token.tokenId };
  };
}
