import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type {
  AgentIncidentChannel,
  AgentIncidentScopeKind,
} from "@/lib/agents/activity-types";
import type {
  OperationalCleanup,
  OperationalResultV1,
} from "@/lib/run-results/operational-types";

import { createHash } from "node:crypto";

import {
  and,
  asc,
  eq,
  isNull,
  lt,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { terminalCauseReason } from "@/lib/domain-events/taxonomy";
import {
  agentIncidentEpisodes,
  agentIncidentOccurrences,
  runs,
  workspaces,
} from "@/lib/db/schema";

const log = pino({
  name: "agent-incidents",
  level: process.env.LOG_LEVEL ?? "info",
});
const MANUAL_REASONS = [
  "source_integrity",
  "external_effects_unknown",
  "evidence_unavailable",
];

export type IncidentRun = Pick<
  Run,
  | "id"
  | "projectId"
  | "sourceAgentId"
  | "agentId"
  | "agentKind"
  | "runKind"
  | "agentWorkspace"
  | "agentActivitySnapshot"
  | "launchedAt"
>;

export type AgentIncidentFact = {
  projectId: string;
  agentId: string;
  sourceFactKey: string;
  scopeKey: string;
  scopeKind: AgentIncidentScopeKind;
  fingerprint: string;
  reasonCode: string;
  runId: string | null;
  channel: AgentIncidentChannel;
  observedAt: Date;
};

function digest(value: object): string {
  return createHash("sha256").update(canonicalCommandJson(value)).digest("hex");
}

async function lockAgent(
  tx: Db,
  projectId: string,
  agentId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${agentId}`}, 0))`,
  );
}

async function laterRecovery(
  tx: Db,
  fact: AgentIncidentFact,
): Promise<{ id: string; endedAt: Date } | null> {
  if (
    fact.scopeKind === "unknown" ||
    fact.channel === "cleanup" ||
    MANUAL_REASONS.includes(fact.reasonCode)
  )
    return null;
  const comparison =
    fact.scopeKind === "infrastructure"
      ? sql`${runs.agentActivitySnapshot}->'comparisonScopes'->>'infrastructure'`
      : sql`${runs.agentActivitySnapshot}->'comparisonScopes'->>'business'`;
  const [run] = await tx
    .select({ id: runs.id, endedAt: runs.endedAt })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, fact.projectId),
        eq(runs.sourceAgentId, fact.agentId),
        eq(runs.agentKind, "operational"),
        eq(runs.status, "Done"),
        sql`${runs.operationalTerminal}->'successful' = 'true'::jsonb`,
        sql`${runs.launchedAt} > ${fact.observedAt}`,
        sql`${comparison} = ${fact.scopeKey}`,
      ),
    )
    .orderBy(asc(runs.launchedAt), asc(runs.id))
    .limit(1);

  return run?.endedAt ? { id: run.id, endedAt: run.endedAt } : null;
}

/** The source owner holds its run lock before acquiring this agent-scope lock. */
export async function recordAgentIncident(
  tx: Db,
  fact: AgentIncidentFact,
): Promise<string> {
  await lockAgent(tx, fact.projectId, fact.agentId);
  const [existing] = await tx
    .select({ episodeId: agentIncidentOccurrences.episodeId })
    .from(agentIncidentOccurrences)
    .where(
      and(
        eq(agentIncidentOccurrences.sourceFactKey, fact.sourceFactKey),
        eq(agentIncidentOccurrences.fingerprint, fact.fingerprint),
      ),
    )
    .limit(1);

  if (existing) return existing.episodeId;
  const recovery = await laterRecovery(tx, fact);
  const [open] = await tx
    .select()
    .from(agentIncidentEpisodes)
    .where(
      and(
        eq(agentIncidentEpisodes.projectId, fact.projectId),
        eq(agentIncidentEpisodes.sourceAgentId, fact.agentId),
        eq(agentIncidentEpisodes.scopeKey, fact.scopeKey),
        eq(agentIncidentEpisodes.fingerprint, fact.fingerprint),
        recovery
          ? eq(agentIncidentEpisodes.recoveryRunId, recovery.id)
          : eq(agentIncidentEpisodes.state, "open"),
      ),
    )
    .limit(1);
  let episodeId: string;

  if (open) {
    episodeId = open.id;
    await tx
      .update(agentIncidentEpisodes)
      .set({
        firstAt: sql`LEAST(${agentIncidentEpisodes.firstAt}, ${fact.observedAt})`,
        lastAt: sql`GREATEST(${agentIncidentEpisodes.lastAt}, ${fact.observedAt})`,
        contentRevision: sql`${agentIncidentEpisodes.contentRevision} + 1`,
      })
      .where(eq(agentIncidentEpisodes.id, open.id));
  } else {
    const [created] = await tx
      .insert(agentIncidentEpisodes)
      .values({
        projectId: fact.projectId,
        sourceAgentId: fact.agentId,
        scopeKey: fact.scopeKey,
        scopeKind: fact.scopeKind,
        fingerprint: fact.fingerprint,
        reasonCode: fact.reasonCode,
        firstAt: fact.observedAt,
        lastAt: fact.observedAt,
        state: recovery ? "resolved" : "open",
        resolvedAt: recovery?.endedAt ?? null,
        recoveryRunId: recovery?.id ?? null,
      })
      .returning({ id: agentIncidentEpisodes.id });

    episodeId = created.id;
    log.info(
      {
        episodeId,
        projectId: fact.projectId,
        agentId: fact.agentId,
        reasonCode: fact.reasonCode,
        recovered: recovery !== null,
      },
      "agent-incident-episode-created",
    );
  }
  await tx.insert(agentIncidentOccurrences).values({
    episodeId,
    sourceFactKey: fact.sourceFactKey,
    fingerprint: fact.fingerprint,
    runId: fact.runId,
    originalRunId: fact.runId,
    channel: fact.channel,
    observedAt: fact.observedAt,
    reasonCode: fact.reasonCode,
  });

  await emitDomainEvent({
    db: tx,
    kind: "agent.incident_changed",
    projectId: fact.projectId,
    payload: {
      projectId: fact.projectId,
      agentId: fact.agentId,
      episodeId,
      revision: open ? open.contentRevision + 1 : 1,
    },
  });

  return episodeId;
}

async function resolveSuccessfulRun(
  tx: Db,
  run: IncidentRun,
  agentId: string,
  endedAt: Date,
): Promise<void> {
  const scopes = run.agentActivitySnapshot?.comparisonScopes;

  if (!scopes || !run.launchedAt || !run.projectId) return;
  await lockAgent(tx, run.projectId, agentId);
  const episodes = await tx
    .select()
    .from(agentIncidentEpisodes)
    .where(
      and(
        eq(agentIncidentEpisodes.projectId, run.projectId),
        eq(agentIncidentEpisodes.sourceAgentId, agentId),
        eq(agentIncidentEpisodes.state, "open"),
        lt(agentIncidentEpisodes.lastAt, run.launchedAt),
        notInArray(agentIncidentEpisodes.reasonCode, MANUAL_REASONS),
      ),
    );

  for (const episode of episodes) {
    const key =
      episode.scopeKind === "business"
        ? scopes.business
        : episode.scopeKind === "infrastructure"
          ? scopes.infrastructure
          : null;

    if (key !== episode.scopeKey) continue;
    const [cleanup] = await tx
      .select({ id: agentIncidentOccurrences.id })
      .from(agentIncidentOccurrences)
      .where(
        and(
          eq(agentIncidentOccurrences.episodeId, episode.id),
          eq(agentIncidentOccurrences.channel, "cleanup"),
        ),
      )
      .limit(1);

    if (cleanup) continue;
    await tx
      .update(agentIncidentEpisodes)
      .set({
        state: "resolved",
        resolvedAt: endedAt,
        recoveryRunId: run.id,
        contentRevision: sql`${agentIncidentEpisodes.contentRevision} + 1`,
      })
      .where(eq(agentIncidentEpisodes.id, episode.id));
    await emitDomainEvent({
      db: tx,
      kind: "agent.incident_changed",
      projectId: run.projectId,
      payload: {
        projectId: run.projectId,
        agentId,
        episodeId: episode.id,
        revision: episode.contentRevision + 1,
      },
    });
    log.info(
      { episodeId: episode.id, runId: run.id },
      "agent-incident-recovered",
    );
  }
}

export type AgentTerminalIncidentInput = {
  run: IncidentRun;
  status: Run["status"];
  endedAt: Date;
  transitionId: string;
  reason: string | undefined;
  terminal: Run["operationalTerminal"];
  reported: OperationalResultV1 | null;
};

export async function applyAgentTerminalIncidents(
  tx: Db,
  input: AgentTerminalIncidentInput,
): Promise<string[]> {
  const run = input.run;
  const agentId = run.sourceAgentId ?? run.agentId;

  if (!run.projectId || !agentId) return [];
  if (input.terminal?.successful === true) {
    await resolveSuccessfulRun(tx, run, agentId, input.endedAt);

    return [];
  }
  if (input.status !== "Failed" && input.status !== "Crashed") return [];
  if (run.agentKind !== "operational") {
    if (
      run.runKind !== "agent" ||
      (run.agentWorkspace !== "none" && run.agentWorkspace !== "repo_read")
    )
      return [];
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.runId, run.id), isNull(workspaces.removedAt)))
      .limit(1);

    if (workspace) return [];
  }
  const episodeIds: string[] = [];

  for (const fact of classifyAgentTerminalFailure(input)) {
    episodeIds.push(await recordAgentIncident(tx, fact));
  }

  return episodeIds;
}

/** Classification uses frozen machine facts and never reads mutable catalog data. */
export function classifyAgentTerminalFailure(
  input: AgentTerminalIncidentInput,
): AgentIncidentFact[] {
  const run = input.run;
  const agentId = run.sourceAgentId ?? run.agentId;

  if (
    !run.projectId ||
    !agentId ||
    (input.status !== "Failed" && input.status !== "Crashed")
  )
    return [];
  const infraStage =
    input.reason === "agent_session_create_failed"
      ? "session_create"
      : input.reason === "agent_prompt_dispatch_failed"
        ? "prompt_dispatch"
        : input.reason === "agent_workspace_prepare_failed"
          ? "workspace_prepare"
          : input.reason === "agent_dispatch_failed"
            ? "dispatch"
            : null;
  const scopes = run.agentActivitySnapshot?.comparisonScopes;
  const scopeKind: AgentIncidentScopeKind = !scopes
    ? "unknown"
    : infraStage
      ? "infrastructure"
      : "business";
  const scopeKey = scopes
    ? infraStage
      ? scopes.infrastructure
      : scopes.business
    : "unknown";
  const safetyReason = input.reported?.references.some(
    (reference) =>
      reference.kind === "operation_receipt" &&
      reference.state === "unresolved",
  )
    ? "external_effects_unknown"
    : input.terminal?.integrity === "changed"
      ? "source_integrity"
      : input.terminal?.integrity === "indeterminate"
        ? "evidence_unavailable"
        : null;
  const platformReason =
    safetyReason ??
    terminalCauseReason(input.reason) ??
    input.terminal?.reasonCodes[0] ??
    (input.status === "Crashed" ? "execution_crashed" : "execution_failed");
  const diagnoses =
    safetyReason ||
    infraStage ||
    input.terminal?.validation === "invalid" ||
    input.status === "Crashed" ||
    !input.reported
      ? [
          {
            code: platformReason,
            operation: infraStage ?? "execution",
            service: null,
            httpStatus: null,
          },
        ]
      : input.reported.diagnostics
          .filter((item) => item.severity === "error")
          .map((item) => ({
            code: item.code,
            operation: item.operation,
            service: item.service ?? null,
            httpStatus: item.httpStatus ?? null,
          }));
  const causes =
    diagnoses.length > 0
      ? diagnoses
      : [
          {
            code: platformReason,
            operation: "execution",
            service: null,
            httpStatus: null,
          },
        ];

  return causes.map((cause) => ({
    projectId: run.projectId!,
    agentId,
    sourceFactKey: `terminal:${input.transitionId}`,
    scopeKind,
    scopeKey,
    fingerprint: digest({ version: 1, scopeKind, ...cause }),
    reasonCode: cause.code,
    runId: run.id,
    channel:
      run.agentKind === "operational"
        ? "operational_terminal"
        : "execution_failure",
    observedAt: input.endedAt,
  }));
}

export async function applyAgentCleanupIncident(
  tx: Db,
  run: IncidentRun,
  cleanup: OperationalCleanup,
  observedAt: Date,
): Promise<void> {
  const agentId = run.sourceAgentId ?? run.agentId;

  if (!run.projectId || !agentId) return;
  if (cleanup.state === "exhausted") {
    const reasonCode = cleanup.errorCode ?? "operational_cleanup_failed";

    await recordAgentIncident(tx, {
      projectId: run.projectId,
      agentId,
      runId: run.id,
      channel: "cleanup",
      sourceFactKey: `cleanup:${run.id}:${cleanup.revision}`,
      scopeKind: "business",
      scopeKey:
        run.agentActivitySnapshot?.comparisonScopes?.business ?? "unknown",
      fingerprint: digest({ version: 1, channel: "cleanup", reasonCode }),
      reasonCode,
      observedAt,
    });

    return;
  }
  if (cleanup.state !== "released") return;
  await lockAgent(tx, run.projectId, agentId);
  await resolveIncidentSource(
    tx,
    run.projectId,
    agentId,
    and(
      eq(agentIncidentOccurrences.originalRunId, run.id),
      eq(agentIncidentOccurrences.channel, "cleanup"),
      isNull(agentIncidentOccurrences.sourceResolvedAt),
    )!,
    observedAt,
  );
}

export async function resolveAgentAdmissionIncident(
  tx: Db,
  projectId: string,
  agentId: string,
  attemptId: string,
  observedAt: Date,
): Promise<void> {
  await lockAgent(tx, projectId, agentId);
  await resolveIncidentSource(
    tx,
    projectId,
    agentId,
    and(
      eq(agentIncidentOccurrences.sourceFactKey, `attempt:${attemptId}`),
      eq(agentIncidentOccurrences.channel, "admission_refusal"),
      isNull(agentIncidentOccurrences.sourceResolvedAt),
    )!,
    observedAt,
  );
}

async function resolveIncidentSource(
  tx: Db,
  projectId: string,
  agentId: string,
  condition: SQL,
  observedAt: Date,
): Promise<void> {
  const occurrences = await tx
    .update(agentIncidentOccurrences)
    .set({ sourceResolvedAt: observedAt })
    .where(condition)
    .returning({ episodeId: agentIncidentOccurrences.episodeId });

  for (const episodeId of new Set(occurrences.map((item) => item.episodeId))) {
    const [remaining] = await tx
      .select({ id: agentIncidentOccurrences.id })
      .from(agentIncidentOccurrences)
      .where(
        and(
          eq(agentIncidentOccurrences.episodeId, episodeId),
          isNull(agentIncidentOccurrences.sourceResolvedAt),
        ),
      )
      .limit(1);

    if (!remaining) {
      const [resolved] = await tx
        .update(agentIncidentEpisodes)
        .set({
          state: "resolved",
          resolvedAt: observedAt,
          contentRevision: sql`${agentIncidentEpisodes.contentRevision} + 1`,
        })
        .where(
          and(
            eq(agentIncidentEpisodes.id, episodeId),
            eq(agentIncidentEpisodes.state, "open"),
          ),
        )
        .returning();

      if (resolved)
        await emitDomainEvent({
          db: tx,
          kind: "agent.incident_changed",
          projectId,
          payload: {
            projectId,
            agentId,
            episodeId,
            revision: resolved.contentRevision,
          },
        });
    }
  }
}
