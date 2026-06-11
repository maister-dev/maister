import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type {
  Assignment,
  AssignmentEvent,
  CapabilityImport,
  EnforcementSnapshotEntry,
  GateResult,
  GateVerdict,
  HitlRequest,
  MaterializationPlan,
  NodeAttempt,
  NodeAttemptType,
  ResolvedCapabilitySet,
} from "@/lib/db/schema";
import type { SettingsNodeView } from "@/lib/flows/settings-view";
import type { HitlOption } from "@/lib/queries/hitl";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { cache } from "react";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { deriveTtlInfo } from "@/lib/gc/ttl";
import { classifyRecover } from "@/lib/runs/recover-classify";
import * as schema from "@/lib/db/schema";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveNodeRecoverInfo } from "@/lib/flows/graph/current-node-kind";
import { buildSettingsView } from "@/lib/flows/settings-view";
import { gcAgeDays, gcWarningDays } from "@/lib/instance-config";
import { extractOptions } from "@/lib/queries/hitl";
import {
  lifecycleActionsForWorkspace,
  type WorkbenchLifecycleAction,
} from "@/lib/queries/portfolio";
import { runnerAgentFromFields } from "@/lib/queries/runner-agent";

const {
  actorIdentities,
  assignmentEvents,
  assignments,
  capabilityImports,
  flowRevisions,
  flows,
  gateResults,
  hitlRequests,
  nodeAttempts,
  projects,
  runs,
  users,
  workspaces,
} = schema;

const log = pino({
  name: "run-queries",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export interface RunPendingHitl {
  hitlRequestId: string;
  kind: HitlRequest["kind"];
  assignmentId: string | null;
  assignmentStatus: Assignment["status"] | null;
  assignmentActionKind: Assignment["actionKind"] | null;
  assignmentRoleRefs: string[];
  assignmentStaleEvidenceSummary: Record<string, unknown> | null;
  assigneeLabel: string | null;
  assigneeUserId: string | null;
  prompt: string;
  options: HitlOption[];
  schema: unknown;
  criticality: "low" | "medium" | "high" | "critical" | null;
  // M30 (ADR-082): the reviewer's recorded dirty-worktree resolution for this
  // visit (null until chosen). Drives the persistent dirty badge after
  // "proceed" and hides the banner actions once a choice is recorded.
  dirtyResolution: "commit" | "discard" | "proceed" | null;
}

export interface RunDetail {
  runId: string;
  projectId: string;
  projectSlug: string;
  status: string;
  currentStepId: string | null;
  branch: string;
  worktreePath: string;
  agent: "claude" | "codex";
  // M18: run kind drives the Review surface — only `flow` runs at `Review` get
  // the ReviewPanel; scratch runs keep their own promote affordance.
  runKind: "flow" | "scratch";
  // M18: the parent repo path + workspace branch/promotion ledger (nullable on
  // pre-M18 rows; the run-detail page derives safe fallbacks, see §3.6).
  parentRepoPath: string;
  projectMainBranch: string;
  projectRepoPath: string;
  baseBranch: string | null;
  baseCommit: string | null;
  targetBranch: string | null;
  promotionMode: string | null;
  prUrl: string | null;
  prNumber: number | null;
  pendingHitl: RunPendingHitl | null;
  // M11b (ADR-030): the user holding an active takeover claim (null unless a
  // takeover node_attempts row is open). Drives the owner-gated Return action.
  takeoverOwnerUserId: string | null;
  // M19: whether a Crashed run can be recovered by the operator. True iff the
  // run is `Crashed` AND `classifyRecover` is not `discard-only` — i.e. an agent
  // node with an `acpSessionId` (`--resume`) OR any session-less node
  // (re-dispatch). Only an agent node with no `acpSessionId` is discard-only.
  // DTO-projected boolean — the raw `acpSessionId` is NEVER surfaced.
  recoverable: boolean;
  // M19 Phase 5: GC TTL projection for terminal (Abandoned/Done) runs — drives
  // a removal-countdown surface on run-detail. DTO-only enums/booleans/Date.
  ttlState: "active" | "warning" | "due";
  effectiveRemovalAt: Date | null;
  archived: boolean;
  pruned: boolean;
  lifecycleActions: WorkbenchLifecycleAction[];
}

// Pure recoverability predicate (no db/clock) so it is fully unit-testable.
// `currentNodeKind` + `retrySafe` are resolved by the caller from the run's
// pinned manifest for the RECOVER TARGET node (resume_target_step_id, retained
// at crash time; current_step_id is nulled on a clean terminal crash).
// Recoverability MUST mirror the backend driver: a Crashed run is recoverable
// unless `classifyRecover` returns `discard-only` — an agent node with a session
// (--resume) or a `retry_safe` session-less node (re-dispatch). A session-less
// node that is NOT retry-safe, or an unresolvable target, is discard-only
// (Codex M19c finding #1 + round-3 fix).
export function isRunRecoverable(input: {
  status: string;
  acpSessionId: string | null;
  currentNodeKind: NodeAttemptType | null;
  retrySafe: boolean;
}): boolean {
  return (
    input.status === "Crashed" &&
    classifyRecover(
      { acpSessionId: input.acpSessionId },
      input.currentNodeKind,
      input.retrySafe,
    ) !== "discard-only"
  );
}

// Wrapped in React `cache()` so the run-detail layout + the `?file=` page child
// (which both need this row) dedupe to a single query per request — the page
// re-renders on `?file=` soft-navs, the layout does not.
export const getRunDetail = cache(async function getRunDetail(
  runId: string,
): Promise<RunDetail | null> {
  const client = db();
  const rows = await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      runKind: runs.runKind,
      currentStepId: runs.currentStepId,
      resumeTargetStepId: runs.resumeTargetStepId,
      acpSessionId: runs.acpSessionId,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      projectSlug: projects.slug,
      projectMainBranch: projects.mainBranch,
      projectRepoPath: projects.repoPath,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      worktreePath: workspaces.worktreePath,
      parentRepoPath: workspaces.parentRepoPath,
      baseBranch: workspaces.baseBranch,
      baseCommit: workspaces.baseCommit,
      targetBranch: workspaces.targetBranch,
      promotionMode: workspaces.promotionMode,
      prUrl: workspaces.prUrl,
      prNumber: workspaces.prNumber,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
      endedAt: runs.endedAt,
      scheduledRemovalAt: workspaces.scheduledRemovalAt,
      archivedBranch: workspaces.archivedBranch,
      removedAt: workspaces.removedAt,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) return null;

  // Recoverability classifies the RECOVER TARGET node: the retained
  // resume_target_step_id (set at crash time), falling back to current_step_id
  // for live/hand-seeded rows. resolveNodeRecoverInfo yields {nodeKind, retrySafe}.
  const recoverTargetStepId = row.resumeTargetStepId ?? row.currentStepId;
  const { nodeKind: recoverNodeKind, retrySafe } = await resolveNodeRecoverInfo(
    client,
    {
      flowRevisionId: row.flowRevisionId,
      flowId: row.flowId,
      stepId: recoverTargetStepId,
    },
  );
  const recoverable = isRunRecoverable({
    status: row.status,
    acpSessionId: row.acpSessionId,
    currentNodeKind: recoverNodeKind,
    retrySafe,
  });
  const ttl = deriveTtlInfo({
    status: row.status,
    endedAt: row.endedAt,
    scheduledRemovalAt: row.scheduledRemovalAt,
    archivedBranch: row.archivedBranch,
    removedAt: row.removedAt,
    nowMs: Date.now(),
    ageDays: gcAgeDays(),
    warningDays: gcWarningDays(),
  });

  const activeTakeoverRows = await client
    .select({ ownerUserId: nodeAttempts.ownerUserId })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        isNull(nodeAttempts.endedAt),
        eq(nodeAttempts.nodeType, "human"),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt));
  const takeoverOwnerUserId =
    activeTakeoverRows.find((r) => r.ownerUserId !== null)?.ownerUserId ?? null;

  const hitlRows = await client
    .select({
      id: hitlRequests.id,
      kind: hitlRequests.kind,
      prompt: hitlRequests.prompt,
      rawSchema: hitlRequests.schema,
      criticality: hitlRequests.criticality,
      dirtyResolution: hitlRequests.dirtyResolution,
    })
    .from(hitlRequests)
    .where(and(eq(hitlRequests.runId, runId), isNull(hitlRequests.respondedAt)))
    .orderBy(desc(hitlRequests.createdAt));
  const pending = hitlRows[0];
  const pendingAssignmentRows = pending
    ? await client
        .select()
        .from(assignments)
        .where(eq(assignments.hitlRequestId, pending.id))
    : [];
  const pendingAssignment = pendingAssignmentRows[0] ?? null;
  const pendingAssigneeRows =
    pendingAssignment?.assigneeActorId != null
      ? await client
          .select({
            label: actorIdentities.label,
            userId: actorIdentities.userId,
          })
          .from(actorIdentities)
          .where(eq(actorIdentities.id, pendingAssignment.assigneeActorId))
      : [];
  const pendingAssignee = pendingAssigneeRows[0] ?? null;

  return {
    runId: row.runId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    status: row.status,
    runKind: row.runKind,
    currentStepId: row.currentStepId,
    branch: row.branch,
    worktreePath: row.worktreePath,
    parentRepoPath: row.parentRepoPath,
    projectMainBranch: row.projectMainBranch,
    projectRepoPath: row.projectRepoPath,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    targetBranch: row.targetBranch,
    promotionMode: row.promotionMode,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    agent: runnerAgentFromFields({
      capabilityAgent: row.capabilityAgent,
      runnerSnapshot: row.runnerSnapshot,
      context: row.runId,
    }),
    takeoverOwnerUserId,
    recoverable,
    ttlState: ttl.ttlState,
    effectiveRemovalAt: ttl.effectiveRemovalAt,
    archived: ttl.archived,
    pruned: ttl.pruned,
    lifecycleActions: lifecycleActionsForWorkspace({
      runKind: row.runKind,
      runStatus: row.status,
      dialogStatus: null,
      hasWorkspace: Boolean(row.workspaceId),
      removedAt: row.removedAt,
      archivedBranch: row.archivedBranch,
    }),
    pendingHitl: pending
      ? {
          hitlRequestId: pending.id,
          kind: pending.kind,
          assignmentId: pendingAssignment?.id ?? null,
          assignmentStatus: pendingAssignment?.status ?? null,
          assignmentActionKind: pendingAssignment?.actionKind ?? null,
          assignmentRoleRefs: pendingAssignment?.roleRefs ?? [],
          assignmentStaleEvidenceSummary:
            pendingAssignment?.staleEvidenceSummary ?? null,
          assigneeLabel: pendingAssignee?.label ?? null,
          assigneeUserId: pendingAssignee?.userId ?? null,
          prompt: pending.prompt,
          options: extractOptions(pending.kind, pending.rawSchema),
          // Permission `schema` carries supervisor-internal handles (requestId,
          // supervisorSessionId, toolCall) — never serialize them to the browser.
          // Mirrors queries/board.ts and queries/hitl.ts; the permission UI
          // renders only `options`, so nulling `schema` loses nothing.
          schema: pending.kind === "permission" ? null : pending.rawSchema,
          criticality: pending.criticality ?? null,
          dirtyResolution: pending.dirtyResolution ?? null,
        }
      : null,
  };
});

// --- M11b: run-detail timeline read model (ADR-030) -----------------------

export interface TimelineGate {
  gateId: string;
  kind: GateResult["kind"];
  mode: GateResult["mode"];
  status: GateResult["status"];
  verdict: GateVerdict | null;
  // `status === 'stale'`: the gate's prior verdict was invalidated (by rework
  // or a takeover return) and MUST rerun before the run can advance.
  stale: boolean;
  endedAt: string | null;
}

// Takeover handoff block, present only on a `human_review` takeover attempt
// (the row carries `owner_user_id`). Owner name falls back to email (name is
// nullable). Returned commits/diff are raw `git log`/`git diff` text.
export interface TimelineHandoff {
  ownerUserId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  baseRef: string | null;
  returnedCommits: string | null;
  returnedDiff: string | null;
}

export interface TimelineAssignmentEvent {
  id: string;
  assignmentId: string;
  actionKind: Assignment["actionKind"];
  title: string;
  eventKind: AssignmentEvent["eventKind"];
  fromStatus: string | null;
  toStatus: string | null;
  actorLabel: string | null;
  actorKind: string | null;
  nodeId: string | null;
  stepId: string | null;
  createdAt: string;
}

export interface TimelineEntry {
  nodeAttemptId: string;
  nodeId: string;
  nodeType: NodeAttempt["nodeType"];
  attempt: number;
  status: NodeAttempt["status"];
  decision: string | null;
  reworkFromNode: string | null;
  acpSessionId: string | null;
  // M30 (ADR-080): true when this attempt was auto-scheduled by retry_policy.
  autoRetry: boolean;
  startedAt: string;
  endedAt: string | null;
  gates: TimelineGate[];
  handoff: TimelineHandoff | null;
}

export interface RunTimeline {
  entries: TimelineEntry[];
  assignmentEvents: TimelineAssignmentEvent[];
}

// One ordered read model over the append-only M11a ledger: every node attempt
// (chronological by started_at then attempt — highest-attempt-wins ordering
// matching M11a templating), its joined gate_results flagged current-vs-stale,
// the acp_session_id checkpoint ref, and the takeover handoff block (owner +
// returned commits/diff/base ref). A legacy linear run with no node_attempts
// yields an empty-but-valid timeline.
export async function getRunTimeline(runId: string): Promise<RunTimeline> {
  const client = db();

  const attemptRows = await client
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
      nodeType: nodeAttempts.nodeType,
      attempt: nodeAttempts.attempt,
      status: nodeAttempts.status,
      decision: nodeAttempts.decision,
      autoRetry: nodeAttempts.autoRetry,
      reworkFromNode: nodeAttempts.reworkFromNode,
      acpSessionId: nodeAttempts.acpSessionId,
      ownerUserId: nodeAttempts.ownerUserId,
      baseRef: nodeAttempts.baseRef,
      returnedCommits: nodeAttempts.returnedCommits,
      returnedDiff: nodeAttempts.returnedDiff,
      startedAt: nodeAttempts.startedAt,
      endedAt: nodeAttempts.endedAt,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(nodeAttempts)
    .leftJoin(users, eq(users.id, nodeAttempts.ownerUserId))
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(asc(nodeAttempts.startedAt), asc(nodeAttempts.attempt));

  const gateRows = await client
    .select({
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      kind: gateResults.kind,
      mode: gateResults.mode,
      status: gateResults.status,
      verdict: gateResults.verdict,
      endedAt: gateResults.endedAt,
    })
    .from(gateResults)
    .where(eq(gateResults.runId, runId))
    .orderBy(asc(gateResults.createdAt));
  const assignmentEventRows = await client
    .select({
      id: assignmentEvents.id,
      assignmentId: assignmentEvents.assignmentId,
      actionKind: assignments.actionKind,
      title: assignments.title,
      eventKind: assignmentEvents.eventKind,
      fromStatus: assignmentEvents.fromStatus,
      toStatus: assignmentEvents.toStatus,
      actorLabel: actorIdentities.label,
      actorKind: actorIdentities.kind,
      nodeId: assignments.nodeId,
      stepId: assignments.stepId,
      createdAt: assignmentEvents.createdAt,
    })
    .from(assignmentEvents)
    .innerJoin(assignments, eq(assignments.id, assignmentEvents.assignmentId))
    .leftJoin(actorIdentities, eq(actorIdentities.id, assignmentEvents.actorId))
    .where(eq(assignmentEvents.runId, runId))
    .orderBy(asc(assignmentEvents.createdAt));

  const gatesByAttempt = new Map<string, TimelineGate[]>();

  for (const g of gateRows) {
    const list = gatesByAttempt.get(g.nodeAttemptId) ?? [];

    list.push({
      gateId: g.gateId,
      kind: g.kind,
      mode: g.mode,
      status: g.status,
      verdict: g.verdict ?? null,
      stale: g.status === "stale",
      endedAt: g.endedAt ? g.endedAt.toISOString() : null,
    });
    gatesByAttempt.set(g.nodeAttemptId, list);
  }

  const entries: TimelineEntry[] = attemptRows.map((r) => ({
    nodeAttemptId: r.id,
    nodeId: r.nodeId,
    nodeType: r.nodeType,
    attempt: r.attempt,
    status: r.status,
    decision: r.decision,
    reworkFromNode: r.reworkFromNode,
    acpSessionId: r.acpSessionId,
    autoRetry: r.autoRetry ?? false,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    gates: gatesByAttempt.get(r.id) ?? [],
    handoff: r.ownerUserId
      ? {
          ownerUserId: r.ownerUserId,
          ownerName: r.ownerName,
          ownerEmail: r.ownerEmail,
          baseRef: r.baseRef,
          returnedCommits: r.returnedCommits,
          returnedDiff: r.returnedDiff,
        }
      : null,
  }));
  const events: TimelineAssignmentEvent[] = assignmentEventRows.map((r) => ({
    id: r.id,
    assignmentId: r.assignmentId,
    actionKind: r.actionKind,
    title: r.title,
    eventKind: r.eventKind,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    actorLabel: r.actorLabel,
    actorKind: r.actorKind,
    nodeId: r.nodeId,
    stepId: r.stepId,
    createdAt: r.createdAt.toISOString(),
  }));

  log.debug(
    { runId, assignmentEventCount: events.length },
    "[FIX:M13] assignment timeline events loaded",
  );

  return { entries, assignmentEvents: events };
}

// --- M11c: run-detail settings-visibility read model (ADR-032) ------------

export interface RunSettings {
  nodes: SettingsNodeView[];
  // Present only when the run carries a recorded `refused` verdict — a strict
  // intent the resolved agent could not honor at launch. Human-readable detail
  // reconstructed from the first refused snapshot entry.
  refusalReason: string | null;
}

function firstRefused(
  snapshotByNode: Record<string, EnforcementSnapshotEntry[]>,
): { nodeId: string; entry: EnforcementSnapshotEntry } | null {
  for (const [nodeId, entries] of Object.entries(snapshotByNode)) {
    const entry = entries.find((e) => e.verdict === "refused");

    if (entry) return { nodeId, entry };
  }

  return null;
}

// The capability-class view for the run-detail panel: the pinned-manifest nodes
// (via runs.flow_revision_id → flow_revisions.manifest), the resolved executor
// agent, and the persisted node_attempts.enforcement_snapshot keyed by nodeId.
// Carries only classes + verdicts — never executor env or any secret.
export async function getRunSettings(
  runId: string,
): Promise<RunSettings | null> {
  const client = db();

  const rows = await client
    .select({
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      runId: runs.id,
      capabilityAgent: runs.capabilityAgent,
      runnerSnapshot: runs.runnerSnapshot,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) return null;

  let manifest: FlowYamlV1 | null = null;

  if (row.flowRevisionId) {
    const revisionRows = await client
      .select({ manifest: flowRevisions.manifest })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, row.flowRevisionId));

    manifest = (revisionRows[0]?.manifest as FlowYamlV1 | undefined) ?? null;
  }

  if (!manifest && row.flowId) {
    const flowRows = await client
      .select({ manifest: flows.manifest })
      .from(flows)
      .where(eq(flows.id, row.flowId));

    manifest = (flowRows[0]?.manifest as FlowYamlV1 | undefined) ?? null;
  }

  if (!manifest) return null;

  const attemptRows = await client
    .select({
      nodeId: nodeAttempts.nodeId,
      enforcementSnapshot: nodeAttempts.enforcementSnapshot,
    })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(asc(nodeAttempts.attempt));

  const snapshotByNode: Record<string, EnforcementSnapshotEntry[]> = {};

  for (const r of attemptRows) {
    if (r.enforcementSnapshot) {
      snapshotByNode[r.nodeId] = r.enforcementSnapshot;
    }
  }

  const graph = compileManifest(manifest);
  const nodes = [...graph.nodes.values()].map((n) => ({
    id: n.id,
    type: n.nodeType,
    settings: n.settings,
  }));

  const agent = runnerAgentFromFields({
    capabilityAgent: row.capabilityAgent,
    runnerSnapshot: row.runnerSnapshot,
    context: row.runId,
  });
  const view = buildSettingsView(nodes, agent, snapshotByNode);

  const refused = firstRefused(snapshotByNode);
  const refusalReason = refused
    ? `node "${refused.nodeId}" declares ${refused.entry.declared} enforcement of "${refused.entry.class}" but the resolved agent can only ${refused.entry.capability} it`
    : null;

  return { nodes: view, refusalReason };
}

// --- M14 T6.1 (ADR-040/041): run-detail capability-profile read model ---------

// A resolved capability revision with its project-scoped trust verdict attached
// from capability_imports. `trustStatus` is null when no import row matches
// (e.g. a built-in capability) — the view never blocks on trust.
export interface CapabilityProfileRevisionView {
  refId: string;
  kind: string;
  sha: string;
  trustStatus: CapabilityImport["trustStatus"] | null;
}

// One ai_coding/judge node attempt's recorded materialization plan (what was
// resolved + materialized at launch), plus its enforcement snapshot. This is
// the HONEST current state: classes are recorded; live enforcement is pending
// verification (ADR-041 — verdicts are still `instructed`). Never surfaces any
// secret — only digests, shas, refIds, kinds, and class names.
export interface CapabilityProfileNode {
  nodeId: string;
  nodeType: NodeAttempt["nodeType"];
  attempt: number;
  enforcementSnapshot: EnforcementSnapshotEntry[] | null;
  plan: Omit<MaterializationPlan, "resolvedRevisions"> & {
    resolvedRevisions: CapabilityProfileRevisionView[];
  };
}

export interface RunCapabilityProfiles {
  nodes: CapabilityProfileNode[];
}

function trustKey(refId: string, sha: string): string {
  return `${refId}@${sha}`;
}

// The capability-profile view for the run-detail panel: every ai_coding/judge
// node_attempt that carries a recorded materialization_plan, in attempt order,
// with each resolved revision's project-scoped trust verdict attached. Returns
// M27/T-B6: the run's launch-frozen resolved capability set (read-only). The
// set is snapshotted at launch (services/runs.ts) and never mutates for the
// life of the run; null for runs launched before the column existed.
export async function getRunResolvedCapabilitySet(
  runId: string,
): Promise<ResolvedCapabilitySet | null> {
  const rows = await db()
    .select({ resolved: runs.resolvedCapabilitySet })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0]?.resolved ?? null;
}

// null when the run has no such node (no capability materialization happened).
export async function getRunCapabilityProfiles(
  runId: string,
): Promise<RunCapabilityProfiles | null> {
  const client = db();

  const runRows = await client
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) return null;

  const attemptRows = await client
    .select({
      nodeId: nodeAttempts.nodeId,
      nodeType: nodeAttempts.nodeType,
      attempt: nodeAttempts.attempt,
      enforcementSnapshot: nodeAttempts.enforcementSnapshot,
      materializationPlan: nodeAttempts.materializationPlan,
    })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        inArray(nodeAttempts.nodeType, ["ai_coding", "judge"]),
        isNotNull(nodeAttempts.materializationPlan),
      ),
    )
    .orderBy(asc(nodeAttempts.attempt));

  if (attemptRows.length === 0) return null;

  const trustRows = await client
    .select({
      capabilityRefId: capabilityImports.capabilityRefId,
      resolvedRevision: capabilityImports.resolvedRevision,
      trustStatus: capabilityImports.trustStatus,
    })
    .from(capabilityImports)
    .where(eq(capabilityImports.projectId, run.projectId));

  const trustByRevision = new Map<string, CapabilityImport["trustStatus"]>();

  for (const t of trustRows) {
    trustByRevision.set(
      trustKey(t.capabilityRefId, t.resolvedRevision),
      t.trustStatus,
    );
  }

  const nodes: CapabilityProfileNode[] = attemptRows.map((r) => {
    const plan = r.materializationPlan as MaterializationPlan;

    return {
      nodeId: r.nodeId,
      nodeType: r.nodeType,
      attempt: r.attempt,
      enforcementSnapshot: r.enforcementSnapshot ?? null,
      plan: {
        ...plan,
        resolvedRevisions: plan.resolvedRevisions.map((rev) => ({
          refId: rev.refId,
          kind: rev.kind,
          sha: rev.sha,
          trustStatus:
            trustByRevision.get(trustKey(rev.refId, rev.sha)) ?? null,
        })),
      },
    };
  });

  return { nodes };
}
