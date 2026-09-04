import "server-only";

import type { CapabilityAgent } from "@/lib/config.schema";
import type { ProjectAction } from "@/lib/authz";
import type { ScheduledLaunchReservation } from "@/lib/scheduled-launches/types";
import type { FlowDelegationSnapshotInput } from "@/lib/flows/delegatable-flow";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import {
  capabilityRefIdSetsFromRecords,
  firstUnknownCapabilityRef,
  firstUnknownPackageMcpRef,
  readAndValidateFormSchemaDoc,
  type CapabilityRefRecord,
} from "@/lib/config";
import { atomicWriteJson } from "@/lib/atomic";
import { loadFlowRunnerBindings } from "@/lib/acp-runners/catalog";
import {
  resolveRunSessions,
  type RunnerCatalogEntry,
  type RunSessionSlot,
} from "@/lib/acp-runners/resolve";
import { materializeProjectBundlesIntoWorktree } from "@/lib/capabilities/materialize-bundle";
import {
  applyPackageVersionChoices,
  revertPackageVersionChoices,
} from "@/lib/local-packages/versions";
import { resolvePinnedFlowRevisionForRefId } from "@/lib/packages/pin";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { type AgentExecutionPolicyRecommendation } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  formatFlowRefError,
  resolveFlowRef,
} from "@/lib/flows/resolve-flow-ref";
import {
  deriveEvaluationParticipationFromSource,
  type InheritedEvaluationParticipation,
} from "@/lib/evaluations/membership";
import {
  assertNodeLaunchable,
  capabilityBearingSettings,
} from "@/lib/flows/enforcement";
import { assertEnforcementEvidence } from "@/lib/flows/enforcement-evidence";
import { checkFlowRequirements } from "@/lib/flows/requirements-check";
import {
  buildResolvedCapabilitySet,
  firstAgentUnsupportedRequiredMcp,
} from "@/lib/capabilities/resolver";
import { normalizeNodeMcps } from "@/lib/config.schema";
import { loadProjectMcpBindings } from "@/lib/mcp/binding-service";
import { compileManifest } from "@/lib/flows/graph/compile";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { assertFlowLaunchable } from "@/lib/flows/launchability-gate";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";
import { runFlow } from "@/lib/flows/runner";
import { worktreesRoot } from "@/lib/instance-config";
import { runtimeRoot } from "@/lib/runtime-root";
import {
  launchProgress,
  type LaunchProgressEvent,
} from "@/lib/runs/launch-progress";
import {
  classifyForceRelaunchLaunchability,
  classifyManualTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import {
  legacyPromotionModeFromStrategy,
  resolveDeliveryPolicy,
  type StoredDeliveryPolicy,
} from "@/lib/runs/delivery-policy";
import {
  assertNoBlindShip,
  requiresLaunchUnattended,
  resolveExecutionPolicy,
  type ExecutionPolicy,
} from "@/lib/runs/execution-policy";
import { activeSessionRunnerId } from "@/lib/runs/active-run-session";
import { applyDefaultBudgetForUnattended } from "@/lib/runs/budget-default";
import { appendManagerRunStreamEvent } from "@/lib/runs/run-stream-event";
import { resolveAgentExecutionPolicy } from "@/lib/agents/execution-policy";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import { actorForUserId, recordTaskActivity } from "@/lib/social/activity";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { tryStartRun } from "@/lib/scheduler";
import {
  localHost,
  mintPlacement,
} from "@/lib/execution-host";
import { executionDataPlaneModeForHost } from "@/lib/execution-host/data-plane-capabilities";
import { fetchProjectRemote, listProjectRemotes } from "@/lib/git-remotes";
import {
  addWorktree,
  assertBaseCommitReachable,
  listBranches,
  removeWorktree,
  resolveBaseCommit,
} from "@/lib/worktree";

// FIXME(any): remove the schema-module bridge once Drizzle's generated table
// types remain stable across the service and integration-test boundaries.
const {
  capabilityRecords,
  evaluationParticipants,
  flowRevisions,
  flows,
  platformAcpRunners,
  platformRuntimeSettings,
  projectFlowRunnerDefaults,
  projectFlowRoles,
  projects,
  runs,
  runSessions,
  runSyncAttempts,
  tasks,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

type RunnerResolutionWarningRecord = {
  readonly sessionName: string;
  readonly warning: NonNullable<
    ReturnType<typeof resolveRunSessions>[number]["resolutionWarning"]
  >;
};

async function appendRunnerResolutionWarningEvents(args: {
  readonly db: ExecutionDb;
  readonly runId: string;
  readonly projectSlug: string;
  readonly taskId: string;
  readonly warnings: readonly RunnerResolutionWarningRecord[];
}): Promise<void> {
  if (args.warnings.length === 0) return;

  const eventsLogPath = path.join(
    runDirPath(runtimeRoot(), args.projectSlug, args.runId),
    "run.events.jsonl",
  );

  for (const { sessionName, warning } of args.warnings) {
    try {
      await appendManagerRunStreamEvent(args.db, {
        runId: args.runId,
        sourceKey: `runner-resolution-warning:${sessionName}:${warning.slotKey}`,
        event: {
          type: "run.runner_resolution_warning",
          data: { sessionName, warning },
        },
        legacyEventsLogPath: eventsLogPath,
      });
    } catch (err) {
      log.error(
        {
          runId: args.runId,
          taskId: args.taskId,
          sessionName,
          slotKey: warning.slotKey,
          err: (err as Error).message,
        },
        "failed to append runner resolution warning event",
      );
    }
  }
}

// Codex-1 (ADR-150 · C): pre-write a controlled recipe's frozen form inputs as
// the run's per-node input artifacts. The graph runner's form node consumes an
// existing `input-<nodeId>.json` (existing-file-wins, runFormCollect) — so a
// controlled launch answers its forms from the recipe passport instead of
// pausing for a human. Only fields the node's OWN form_schema declares are
// written to it; evaluation preflight already guarantees every required field
// is supplied and every supplied field is known (D16). A form node with no
// matching field keeps its interactive HITL.
async function writeEvaluationFormInputs(args: {
  compiled: ReturnType<typeof compileManifest>;
  flowInstallPath: string;
  projectSlug: string;
  runId: string;
  formValues: Record<string, unknown>;
}): Promise<void> {
  if (Object.keys(args.formValues).length === 0) return;

  const dir = runDirPath(runtimeRoot(), args.projectSlug, args.runId);
  let dirCreated = false;

  for (const node of args.compiled.nodes.values()) {
    if (node.nodeType !== "form") continue;
    const schemaRef = (node.settings as { form_schema?: string } | undefined)
      ?.form_schema;

    if (typeof schemaRef !== "string" || schemaRef.length === 0) continue;

    const doc = await readAndValidateFormSchemaDoc(
      args.flowInstallPath,
      schemaRef,
    );
    const subset: Record<string, unknown> = {};

    for (const field of doc.fields) {
      if (field.name in args.formValues) {
        subset[field.name] = args.formValues[field.name];
      }
    }

    if (Object.keys(subset).length === 0) continue;

    if (!dirCreated) {
      await mkdir(dir, { recursive: true });
      dirCreated = true;
    }
    await atomicWriteJson(path.join(dir, `input-${node.id}.json`), subset);
  }
}

// M13: a launch is refused (CONFIG → 400) when any compiled node's
// finish.human.role or settings.roles references a Flow role not in the
// project's active (non-archived) project_flow_roles registry. An empty
// registry skips the check (no roles configured yet).
function assertCompiledFlowRolesLaunchable(args: {
  compiled: ReturnType<typeof compileManifest>;
  activeRoleRefs: ReadonlySet<string>;
  flowRefId: string;
  projectSlug: string;
}): void {
  if (args.activeRoleRefs.size === 0) return;

  for (const node of args.compiled.nodes.values()) {
    const finishRole = node.finishHuman?.role;

    if (finishRole !== undefined && !args.activeRoleRefs.has(finishRole)) {
      throw new MaisterError(
        "CONFIG",
        `flow "${args.flowRefId}" node "${node.id}" finish.human.role references unknown active Flow role "${finishRole}" for project ${args.projectSlug}`,
      );
    }

    if (node.source.node.type !== "human" && node.source.node.type !== "form") {
      continue;
    }

    for (const role of node.source.node.settings?.roles ?? []) {
      if (args.activeRoleRefs.has(role)) continue;

      throw new MaisterError(
        "CONFIG",
        `flow "${args.flowRefId}" node "${node.id}" settings.roles references unknown active Flow role "${role}" for project ${args.projectSlug}`,
      );
    }
  }
}

// FIXME(any): narrow this injected database seam to the operations used here.
type Db = any;

const log = pino({
  name: "service-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LaunchRunInput = {
  taskId: string;
  flowId?: string;
  runnerId?: string;
  baseBranch?: string;
  baseCommit?: string;
  relaunchOfRunId?: string;
  targetBranch?: string;
  deliveryPolicy?: StoredDeliveryPolicy;
  executionPolicy?: ExecutionPolicy;
  // M39 (ADR-106): an agent-driven flow run records the driving agent — the
  // persona/policy source the graph runner injects on every ai_coding node.
  // null/absent for a normal board flow run.
  agentId?: string | null;
  // M39 (ADR-106): a flow-driving agent's {autoApply, onBudgetBreach} axes,
  // OVERLAID onto the resolved task/project base policy (not a wholesale launch
  // override) so inherited axes such as budget limits survive. null/absent for a
  // normal board flow run.
  agentPolicyOverlay?: AgentExecutionPolicyRecommendation | null;
  // M39 (ADR-106): trigger provenance for an agent-driven flow run — recorded on
  // runs(trigger_source, trigger_event_id, trigger_payload) so the partial unique
  // (agent_id, trigger_event_id) claim dedups an at-least-once redelivery.
  // null/absent for a normal board launch (carries no trigger event).
  triggerSource?:
    | "manual"
    | "cron"
    | "domain_event"
    | "webhook"
    | "flow"
    | "scheduled";
  triggerEventId?: number | null;
  triggerPayload?: Record<string, unknown> | null;
  // Owner binding for an agent cron/domain-event launch. This is server-owned
  // trigger provenance, never a browser field.
  agentScheduleId?: string | null;
  // ADR-139: server-only durable identity allocated by the scheduled-launch
  // claim transaction. Routes never accept this shape; retaining it through the
  // ordinary launch path closes the pre-Run Git crash window without a second
  // side-channel Run insert.
  scheduledReservation?: ScheduledLaunchReservation;
  // M39 Stream B (ADR-107): per-package version-adopt choice for the project's
  // attached centralized packages (key = the attached package_install id).
  // Applied BEFORE the enablement check so adopt/cut_and_adopt take effect for
  // this launch. Absent/keep = launch on the pin; server-constrained to the
  // launch-detected available set (unknown/ineligible → CONFLICT).
  packageVersions?: Record<
    string,
    "keep" | "adopt" | "cut_and_adopt" | "try_once"
  >;
  // ADR-132 §a: ephemeral per-run package pin. The task flow's revision
  // resolves from THIS `package_installs` row (join on the flow's flowRefId +
  // the install's resolvedRevision) instead of the attachment's enabled
  // pointer; `project_package_attachments` is never mutated. Internal callers
  // only (the evaluation controlled-launch seam; the try_once launch choice translates
  // into it) — not exposed on the public POST /api/runs body. A caller never
  // combines it with a non-keep `packageVersions` choice for the same package
  // (try_once translation REMOVES the choice it converts).
  packagePin?: { packageInstallId: string };
  // ADR-119: force-relaunch flag. When true, the launch gate uses
  // classifyForceRelaunchLaunchability (every RUN status is launchable; only the
  // TASK gates flagged/blocked refuse), allowing an additive concurrent run
  // alongside a still-running one. Absent/false ⇒ classifyManualTaskLaunchability
  // (the busy gate). Never bypasses the task gates. Manual-only — scheduled /
  // auto-launch / run-schedule paths never set it.
  allowConcurrent?: boolean;
  // ADR-126 T10: launch-time auto-promotion opt-out. `false` ⇒ a `launch`-sourced
  // promotion_hold is written at run INSERT; unset/true ⇒ no hold.
  autoPromote?: boolean;
  // ADR-146 D15: server-internal marker for a controlled evaluation launch (the
  // launch-batch seam adapter). When set, the run INSERT writes an
  // `evaluation_study`-sourced promotion hold (forced — independent of
  // `autoPromote`) so the participant can never auto-promote/auto-deliver and
  // the DELETE hold route can refuse clearing it while the study is live. Never
  // accepted from a route body; a launched-participant restart derives the same
  // hold from its inherited participation instead.
  evaluationStudyId?: string;
  // ADR-150: the controlled-launch batch item id (the seam's `launchKey`),
  // persisted on runs.evaluation_batch_item_id INSIDE this run's INSERT. It is
  // the idempotency handle — a re-driven batch item re-invokes the seam with the
  // SAME id and ADOPTS the existing run (partial UNIQUE) rather than launching a
  // second. Server-internal (seam adapter only); never a route body field.
  evaluationBatchItemId?: string;
  // ADR-150: per-session runner overrides `{ sessionName: runnerId }` from a
  // controlled recipe's resolved slot bindings, so a launched variant runs on
  // ITS recipe's chosen runners (not the task default). Threaded into the same
  // `ephemeralOverrides` the single launch-dialog `runnerId` uses; a concrete
  // override always wins over the default chain. Seam adapter only.
  sessionRunnerOverrides?: Record<string, string>;
  // Codex-1 (ADR-150 · C): the controlled recipe's pinned flow revision. The
  // launch resolves + validates THIS revision through the same guards as an
  // enabled one and the run EXECUTES it (the runner loads the manifest from
  // runs.flow_revision_id) — the recipe passport is honored by construction,
  // not merely recorded. Seam adapter only; never a route body field.
  evaluationFlowRevisionId?: string;
  // Codex-1 (ADR-150 · C): the recipe's frozen form inputs. Each form node's
  // declared subset is pre-written as `input-<nodeId>.json` BEFORE the run row
  // exists, so the graph runner's existing-file-wins branch answers the form
  // from the passport instead of pausing for a human. Seam adapter only.
  evaluationFormInputs?: Record<string, unknown>;
  // ADR-121 (INV-9): mark this run as auto-DRAINED — stamps runs.queue_admitted_at
  // at insert so it counts toward the per-project `maxInFlightAuto` share and is
  // distinguishable from manual/scratch/resume runs. Set ONLY by the unified
  // admission funnel (the auto-launch poll / slot-free gate), never by a manual or
  // ADR-119 force-relaunch launch.
  queueAdmitted?: boolean;
  // ADR-122 (T5.3): the launch-time "include ambient Project Brain context"
  // decision, persisted to runs.brain_context. null/absent = inherit the
  // flow/agent default at ambient-inject time. The launch persists ONLY this
  // boolean — no recall/embedding call, no snapshot insert happens here
  // (snapshots are consumption-time: T4.3 ambient / T4.2 explicit).
  brainContext?: boolean | null;
  // ADR-163: delegation provenance for a flow run launched as an orchestrator's
  // child. SERVER-INTERNAL — set only by the delegation seam, never accepted
  // from a route body (the same idiom as `scheduledReservation` and
  // `evaluationBatchItemId`). Absent for every board / scheduled / agent-driven
  // launch, which is what keeps a top-level run's run-tree columns NULL.
  parentRunId?: string;
  rootRunId?: string;
  launchMode?: "auto" | "manual";
  // The flow arm deliberately OMITS `baseBranch`/`targetBranch`: this launcher
  // is what resolves them (input -> task defaults -> project main), so it is
  // what records them. A caller that supplied its own pair would be duplicating
  // a resolution it cannot see the inputs to, which is how the snapshot and the
  // workspace drift apart.
  delegationSnapshot?: FlowDelegationSnapshotInput;
};

function budgetRestartSourceRunId(
  triggerPayload: Record<string, unknown> | null | undefined,
): string | null {
  if (
    triggerPayload === null ||
    triggerPayload === undefined ||
    triggerPayload.kind !== "budget_restart"
  ) {
    return null;
  }
  if (typeof triggerPayload.oldRunId !== "string") {
    throw new MaisterError(
      "PRECONDITION",
      "budget restart trigger payload is missing oldRunId",
    );
  }

  return triggerPayload.oldRunId;
}

function membershipSourceForLaunch(input: LaunchRunInput): {
  sourceRunId: string;
  launchReason: "manual_relaunch" | "budget_restart";
} | null {
  if (input.relaunchOfRunId) {
    return {
      sourceRunId: input.relaunchOfRunId,
      launchReason: "manual_relaunch",
    };
  }

  const budgetSourceRunId = budgetRestartSourceRunId(input.triggerPayload);

  if (budgetSourceRunId === null) return null;

  return {
    sourceRunId: budgetSourceRunId,
    launchReason: "budget_restart",
  };
}

export type PromotionMode = "local_merge" | "rebase_merge" | "pull_request";

// M18 §3.4: resolve the per-run promotion mode from the override chain. The
// `local_merge` default is folded HERE (not as a per-key zod default), so a
// CLEARed project value (null) resolves back to the default. Only the two
// valid enum members are accepted; any other value falls through to the
// default rather than being persisted as-is.
export function resolvePromotionMode(args: {
  launchOverride?: string | null;
  projectPromotionMode?: string | null;
}): PromotionMode {
  const candidate = args.launchOverride ?? args.projectPromotionMode;

  if (
    candidate === "local_merge" ||
    candidate === "rebase_merge" ||
    candidate === "pull_request"
  ) {
    return candidate;
  }

  return "local_merge";
}

async function assertPinnedBaseCommitReachable(args: {
  projectId: string;
  taskId: string;
  projectRepoPath: string;
  baseRef: string;
  baseCommit: string;
}): Promise<string> {
  try {
    return await assertBaseCommitReachable({
      projectRepoPath: args.projectRepoPath,
      baseRef: args.baseRef,
      baseCommit: args.baseCommit,
      preferRemote: "origin",
    });
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;

    log.warn(
      {
        projectId: args.projectId,
        taskId: args.taskId,
        baseRef: args.baseRef,
        baseCommit: args.baseCommit,
        code: isMaisterError(err) ? err.code : undefined,
        err: err instanceof Error ? err.message : String(err),
        gitExitCode: (cause as { code?: unknown } | undefined)?.code,
        gitSignal: (cause as { signal?: unknown } | undefined)?.signal,
      },
      "POST /api/runs pinned base commit rejected",
    );

    throw err;
  }
}

function runnerProviderKind(provider: unknown): string {
  if (
    provider &&
    typeof provider === "object" &&
    "kind" in provider &&
    typeof provider.kind === "string"
  ) {
    return provider.kind;
  }

  throw new MaisterError(
    "CONFIG",
    `platform ACP runner has invalid provider payload: ${JSON.stringify(provider)}`,
  );
}

function runnerCatalogEntry(row: Record<string, any>): RunnerCatalogEntry {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    env: row.env,
    provider: row.provider,
    providerKind: runnerProviderKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

export type LaunchRunContext = {
  actorUserId?: string | null;
  authorize: (projectId: string, action?: ProjectAction) => Promise<void>;
  assertLaunchOwnership?: (db: Db) => Promise<void>;
  recordSuccessAudit?: (db: Db) => Promise<void>;
};

// Phase 6 (FR-F1/F2, T6.3): the staged flow launch. Mirrors the scratch seam —
// every precondition runs up to the first `yield "precondition"`, so the route
// can drive ONE `.next()` and map a head-check failure to a JSON error BEFORE
// committing to `text/event-stream`. Flow launch has NO synchronous session
// spawn (the engine runs `runFlow` in the background), so it emits only
// `precondition → worktree_created → materializing(<adapter>)` and then returns
// the terminal `{runId, status, queuePosition?}`. `opts.signal` aborts at the
// materialize boundary → the existing worktree compensation (pre-commit GC).
// ADR-132 §a: the ephemeral-pin matrix lives in the neutral
// `@/lib/packages/pin` module (shared with the evaluation controlled-launch
// batch validation). This wrapper adapts it to the launch path's flow row.
async function resolvePinnedFlowRevision(
  _db: any,
  flow: Record<string, any>,
  packageInstallId: string,
): Promise<Record<string, any>> {
  return resolvePinnedFlowRevisionForRefId(_db, {
    flowRefId: flow.flowRefId,
    packageInstallId,
  });
}

export async function* launchRunStaged(
  input: LaunchRunInput,
  ctx: LaunchRunContext,
  db?: Db,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<
  LaunchProgressEvent,
  { runId: string; status: string; queuePosition?: number },
  void
> {
  // FIXME(any): narrow this injected database seam to the operations used here.
  const _db = (db ?? getDb()) as unknown as {
    select: any;
    insert: any;
    update: any;
    transaction: any;
  };

  const taskRows = await _db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));
  const task = taskRows[0];

  if (!task) {
    throw new MaisterError("PRECONDITION", `task not found: ${input.taskId}`);
  }
  const projectRows = await _db
    .select()
    .from(projects)
    .where(eq(projects.id, task.projectId));
  const project = projectRows[0];

  if (!project) {
    throw new MaisterError("PRECONDITION", "project not found for task");
  }

  // Authorize before any archived/launchability/blocker evaluation —
  // classification detail (incl. blocker KEY-N refs) must not leak to
  // callers without project access. AuthzError propagates untouched.
  await ctx.authorize(project.id);

  // Execution-control policy: resolve (launch override → task → project →
  // supervised), reject blind-ship combos, then gate non-supervised launches
  // behind the privileged action. Snapshotted onto runs.execution_policy below;
  // resume/recover read the snapshot, never re-resolve.
  const basePolicy = resolveExecutionPolicy({
    launchOverride: input.executionPolicy ?? null,
    taskDefault: (task.executionPolicy as ExecutionPolicy | null) ?? null,
    projectDefault:
      (project.executionPolicyDefault as ExecutionPolicy | null) ?? null,
  });
  // M39 (ADR-106): a flow-driving agent OVERLAYS its {autoApply, onBudgetBreach}
  // axes onto the resolved task/project base — it does not replace it, so
  // inherited axes (budget limits) survive. Absent overlay ⇒ base is used as-is.
  const executionPolicy = applyDefaultBudgetForUnattended(
    input.agentPolicyOverlay
      ? resolveAgentExecutionPolicy({
          instanceOverride: input.agentPolicyOverlay,
          recommended: null,
          base: basePolicy,
        })
      : basePolicy,
  );

  assertNoBlindShip(executionPolicy);

  if (requiresLaunchUnattended(executionPolicy)) {
    await ctx.authorize(project.id, "launchUnattended");
  }

  if (project.archivedAt) {
    throw new MaisterError("PRECONDITION", "project is archived");
  }

  const inheritanceSource = membershipSourceForLaunch(input);
  // ADR-146 D15: a relaunch/budget-restart of a LAUNCHED evaluation participant
  // mints a
  // SUCCESSOR participant row (same study/recipe lineage, new runId) in the
  // run-insert tx below, so the replacement run stays launched-lineage-held —
  // without it the restart would be the escape hatch out of the study's
  // no-auto-promotion/no-auto-delivery guarantee.
  const inheritedEvaluationParticipation: InheritedEvaluationParticipation | null =
    inheritanceSource === null
      ? null
      : await deriveEvaluationParticipationFromSource(_db as never, {
          sourceRunId: inheritanceSource.sourceRunId,
          taskId: task.id,
        });
  // A budget-restarted launched participant relaunches INDEPENDENTLY of its
  // still-active study siblings (the widened HITL preflight already classified
  // it force-relaunchable — without this the widening was a no-op and the
  // restart died `PRECONDITION busy`).
  const forceByBudgetEvaluationParticipation =
    inheritedEvaluationParticipation !== null &&
    inheritanceSource?.launchReason === "budget_restart";
  const allowConcurrentForLaunch = input.scheduledReservation
    ? false
    : Boolean(input.allowConcurrent || forceByBudgetEvaluationParticipation);
  // The study whose forced `evaluation_study` promotion hold this run carries:
  // an explicit controlled launch (seam adapter) or inherited participation.
  const evaluationHoldStudyId =
    input.evaluationStudyId ??
    inheritedEvaluationParticipation?.studyId ??
    null;

  if (inheritedEvaluationParticipation) {
    log.info(
      {
        sourceRunId: inheritanceSource?.sourceRunId,
        studyId: inheritedEvaluationParticipation.studyId,
        recipeId: inheritedEvaluationParticipation.recipeId,
        replicateOrdinal: inheritedEvaluationParticipation.replicateOrdinal,
        launchReason: inheritanceSource?.launchReason,
        forceByBudgetEvaluationParticipation,
      },
      "POST /api/runs inherited evaluation participation",
    );
  }

  // tasks.status is a one-way latch (nothing writes Backlog back after
  // launch), so the latest flow run — not the task row — decides
  // relaunchability (board retry rule, attempt N+1).
  const latestFlowRun = await getLatestFlowRun(input.taskId, _db);
  const openBlockers =
    (await getOpenRelationBlockers([input.taskId], _db)).get(input.taskId) ??
    [];
  // ADR-119: the force flag widens ONLY the run-status gate (busy → launchable)
  // for an additive concurrent run; the task gates flagged/blocked still refuse.
  const classifyLaunchability = allowConcurrentForLaunch
    ? classifyForceRelaunchLaunchability
    : classifyManualTaskLaunchability;
  const launchability = classifyLaunchability(task, latestFlowRun, {
    openBlockers,
  });

  log.debug(
    {
      taskId: input.taskId,
      mode: allowConcurrentForLaunch ? "force" : "manual",
      allowConcurrent: allowConcurrentForLaunch,
      forceByBudgetEvaluationParticipation,
      verdict: launchability,
    },
    "[launchability.force] launch gate classifier selected",
  );

  if (launchability !== "launchable") {
    if (launchability === "blocked") {
      log.warn(
        {
          taskId: input.taskId,
          blockers: openBlockers.map((b) => `${b.key}-${b.number}`),
        },
        "launch refused: blocked",
      );
    }

    const blockerSuffix =
      launchability === "blocked"
        ? ` — blocked by ${openBlockers.map((b) => `${b.key}-${b.number}`).join(", ")}`
        : "";

    throw new MaisterError(
      "PRECONDITION",
      `task is not launchable (classification: ${launchability})${blockerSuffix}`,
    );
  }
  log.debug(
    { taskId: input.taskId, classification: launchability },
    "launch gate",
  );

  // A launch-time flowId override is body-controlled and may name the flow by
  // its `flows.id` or the project's `flows.flow_ref_id`; `task.flowId` is
  // already a resolved id. (Session-auth only — the ext runs route refuses
  // `flowId` per ADR-085.)
  let overrideFlowId = input.flowId ?? null;

  if (overrideFlowId !== null) {
    const resolution = await resolveFlowRef(project.id, overrideFlowId, _db);

    if (!resolution.ok) {
      throw new MaisterError(
        "PRECONDITION",
        formatFlowRefError(resolution.detail),
      );
    }

    overrideFlowId = resolution.flowId;
  }

  const flowRows = await _db
    .select()
    .from(flows)
    .where(eq(flows.id, overrideFlowId ?? task.flowId));
  let flow = flowRows[0];

  if (!flow) {
    throw new MaisterError("PRECONDITION", "flow not found for task");
  }
  if (flow.projectId !== project.id) {
    throw new MaisterError(
      "PRECONDITION",
      `flow "${flow.id}" is not enabled for project ${project.slug}`,
    );
  }

  // M39 Stream B (ADR-107): gate the supervisor's readiness BEFORE advancing the
  // project pin. The dominant transient failure (supervisor down/restarting) must
  // not leave the shared pin silently advanced on a launch that cannot run; a full
  // re-check with runner context still runs post-resolution below.
  // ADR-166 D1: the registered local execution host is the readiness gate —
  // unreachable, refused (identity changed under live runs), or pre-ADR-166
  // supervisors all surface as EXECUTOR_UNAVAILABLE here. The host row is what
  // the launch tx places the run on.
  const placementHost = await localHost({
    db: _db as unknown as ExecutionDb,
  });
  const executionDataPlaneMode = executionDataPlaneModeForHost(placementHost);

  // ADR-132 §a: validate the ephemeral per-run package pin as a cheap
  // deterministic precondition, hoisted BEFORE applyPackageVersionChoices so a
  // refused pin never triggers the adopt/revert compensation window. The
  // resolved revision then flows through the SAME downstream guards
  // (packageStatus/setupStatus/schemaVersion/engine) as an enabled revision;
  // the run snapshot columns point at it, and the attachment is never touched.
  let pinnedRevision: Record<string, any> | null = null;

  if (input.packagePin) {
    pinnedRevision = await resolvePinnedFlowRevision(
      _db,
      flow,
      input.packagePin.packageInstallId,
    );
  }

  // Codex-1 (ADR-150 · C): the evaluation seam pins the run to the recipe's
  // exact flow revision. The row flows through the SAME downstream guards as an
  // ADR-132 packagePin (packageStatus/setupStatus/schema/engine) and the run
  // insert snapshots it, so the runner executes exactly this revision.
  // Ownership fails closed: a revision of another flow can never execute here.
  if (input.evaluationFlowRevisionId) {
    if (pinnedRevision) {
      throw new MaisterError(
        "CONFLICT",
        "evaluationFlowRevisionId and packagePin cannot target the same launch",
      );
    }
    const evalRevisionRows = await _db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.id, input.evaluationFlowRevisionId));
    const evalRevision = evalRevisionRows[0];

    if (!evalRevision || evalRevision.flowRefId !== flow.flowRefId) {
      throw new MaisterError(
        "PRECONDITION",
        `pinned evaluation flow revision ${input.evaluationFlowRevisionId} does not exist for flow "${flow.flowRefId}"`,
      );
    }
    pinnedRevision = evalRevision;
  }

  // M39 Stream B (ADR-107): apply the launcher's version-adopt choices for the
  // project's attached centralized packages BEFORE the enablement check reads
  // flow.enabled_revision_id — adopt/cut_and_adopt advance the project
  // attachment (each its own tx), so this very launch uses the adopted cut.
  // keep/absent = no-op; an unoffered choice → CONFLICT (409); a cut_and_adopt
  // on a locked/invalid package → PRECONDITION (the launcher can still keep).
  // `adoptReverts` re-pin the attachment if the launch fails after the adopt (see
  // the worktree-compensation catch below). Flow runs keep
  // runs.local_package_id NULL (no run override).
  const { reverts: adoptReverts, tryOncePins } =
    await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: input.packageVersions,
      db: _db as never,
      signal: opts.signal,
    });

  // Hoisted above the outer try so the post-compensation tryStartRun / return
  // block can still read it (the try opens right after the adopt).
  const scheduledReservation = input.scheduledReservation;
  const runId = scheduledReservation?.runId ?? randomUUID();
  // ADR-150: set inside the run-insert tx when a controlled-launch re-drive
  // adopts an already-launched batch item instead of inserting. Non-null after
  // the tx means THIS attempt is a duplicate — its fresh worktree is an orphan
  // to compensate, and the adopted (existing) run is returned as the result.
  let adoptedRunId: string | null = null;
  // The freshly-created worktree of THIS attempt, captured for the adopt-path
  // compensation (its `const` twin is scoped inside the launch try).
  let createdWorktreePath: string | null = null;
  let runnerResolutionWarnings: RunnerResolutionWarningRecord[] = [];

  // ADR-107: adopt advanced the SHARED project pin. Everything below, up to the
  // durable run-insert, is fallible — this outer try re-pins the attachment(s) on
  // ANY failure (the dropped-flow refusal, a later precondition, addWorktree, the
  // transaction). Its catch reads only pre-adopt vars (adoptReverts/project/_db),
  // so they stay in scope; the nested try below compensates the worktree.
  try {
    if (adoptReverts.length > 0) {
      const reloadedFlow = await _db
        .select()
        .from(flows)
        .where(eq(flows.id, flow.id));

      // The adopted cut may no longer ship this flow (upgradeAttachment drops
      // member flows the new manifest removed). Refuse rather than launch on the
      // stale, now-deleted flow row / its orphaned revision.
      if (!reloadedFlow[0]) {
        throw new MaisterError(
          "PRECONDITION",
          `the adopted package version no longer ships flow "${flow.flowRefId}" — choose a different version or flow`,
        );
      }
      flow = reloadedFlow[0];
    }

    // ADR-132: translate try_once choices into the ephemeral per-run pin.
    // Inside the compensation window on purpose — a refused translation after
    // a same-launch adopt must revert that adopt (outer catch). The pin matrix
    // re-validates the target cut; an install that does not ship THIS flow
    // refuses CONFIG (acceptance #3), and two packages both shipping it is an
    // ambiguity refusal rather than a silent first-wins.
    if (tryOncePins.length > 0) {
      if (pinnedRevision) {
        throw new MaisterError(
          "CONFLICT",
          "a pinned revision (packagePin / evaluation pin) and a try_once choice cannot target the same launch",
        );
      }
      for (const tryOnce of tryOncePins) {
        const revision = await resolvePinnedFlowRevision(
          _db,
          flow,
          tryOnce.packageInstallId,
        );

        if (pinnedRevision) {
          throw new MaisterError(
            "CONFLICT",
            `ambiguous try_once: more than one package ships flow "${flow.flowRefId}"`,
          );
        }
        pinnedRevision = revision;
      }
    }

    // Resolve the project-enabled package revision (M10, ADR-021) and refuse
    // launch through the ONE shared launchability gate — BEFORE any workspace
    // creation. The revision is server-derived from the enablement pointer,
    // never body-controlled.
    //
    // M27/T-B4: resolve the effective revision per flows.version_binding (ADR-069).
    // `pinned` = the enabled pointer (unchanged behavior); `latest` = the newest
    // Installed revision for this flow_ref_id (a just-published authored revision
    // floats in via the bridge). The gate below still checks the RESOLVED
    // revision (packageStatus/setupStatus/engine/schema).
    // ADR-132: an ephemeral packagePin overrides the resolution — the
    // already-loaded pinned revision IS the effective revision (no re-select;
    // launch-time decision, persisted via the snapshot columns below).
    const effectiveRevisionId = pinnedRevision
      ? pinnedRevision.id
      : flow.enabledRevisionId
        ? ((await resolveEffectiveFlowRevision(_db, flow)) ??
          flow.enabledRevisionId)
        : null;

    const revisionRows = pinnedRevision
      ? [pinnedRevision]
      : effectiveRevisionId
        ? await _db
            .select()
            .from(flowRevisions)
            .where(eq(flowRevisions.id, effectiveRevisionId))
        : [];
    const revision = revisionRows[0];

    assertFlowLaunchable(flow.flowRefId, flow, revision ?? null);

    const manifest = parseExecutableStoredFlowManifest(revision.manifest, {
      code: "CONFIG",
      surface: "launch-service",
      manifestLabel: `flow revision ${revision.id}`,
      flowRefId: flow.flowRefId,
      revision: revision.resolvedRevision,
    });

    // ADR-091: launch-time host/runtime requirements (e.g. an external CLI the
    // flow shells out to). Probed in the project repo BEFORE any worktree/session
    // exists — a missing binary fails clean as PRECONDITION here, not late
    // mid-run after token spend. Check-only: MAIster never auto-installs (trust);
    // each requirement's `hint` carries the remediation. No-op when none declared.
    await checkFlowRequirements(manifest.requirements, project.repoPath);

    const compiled = compileManifest(manifest);

    // ADR-165 (T4.1 / R12): the run's PUBLIC result contract, resolved from the
    // PINNED revision's install path BEFORE any worktree exists. An unresolvable
    // export schema refuses CONFIG here, with zero `runs` / `workspaces` rows —
    // resolving it later, at the seam, would mean the failure arrived after a
    // worktree, a session and token spend. The snapshot is what the seam, the
    // terminal gate and the collect route read; none of them re-reads the
    // revision, so re-pointing the flow afterwards cannot change this run.
    const resultContract = await resolveFlowExportContract({
      flowRefId: flow.flowRefId,
      manifest,
      revision,
    });

    const runtimeRows = await _db
      .select()
      .from(platformRuntimeSettings)
      .where(eq(platformRuntimeSettings.id, "singleton"));
    const platformRuntime = runtimeRows[0];

    if (!platformRuntime) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "platform default ACP runner is not configured",
      );
    }

    const runnerRows = await _db.select().from(platformAcpRunners);
    const runnerCatalog = runnerRows.map(runnerCatalogEntry);

    const projectFlowDefaultRows = await _db
      .select({ runnerId: projectFlowRunnerDefaults.runnerId })
      .from(projectFlowRunnerDefaults)
      .where(
        and(
          eq(projectFlowRunnerDefaults.projectId, project.id),
          eq(projectFlowRunnerDefaults.flowId, flow.id),
        ),
      );
    const projectFlowDefaultRunnerId =
      projectFlowDefaultRows[0]?.runnerId ?? null;
    // M42 (ADR-114): resolve EVERY logical session of the flow to a concrete host
    // runner. A flow with no runner-bearing node still gets the implicit `default`
    // session (the legacy single-runner-per-run behavior). Resolution THROWS on an
    // unbound/ambiguous/no-host slot — the launch fails clean before any worktree.
    const bindings = await loadFlowRunnerBindings(_db, project.id, revision.id);
    const compiledSessions = [...compiled.sessions.values()];
    const sessionSlots: RunSessionSlot[] =
      compiledSessions.length > 0 ? compiledSessions : [{ name: "default" }];
    const primarySessionName =
      sessionSlots.find((session) => session.name === "default")?.name ??
      sessionSlots[0].name;
    const sessionResolutions = resolveRunSessions({
      sessions: sessionSlots,
      runnerProfiles: manifest.runner_profiles,
      bindings,
      // The single launch-dialog override applies to the run's primary session;
      // ADR-150 controlled-recipe per-session overrides apply to their named
      // sessions. The primary-session override wins on a key collision.
      ephemeralOverrides:
        input.runnerId || input.sessionRunnerOverrides
          ? {
              ...(input.sessionRunnerOverrides ?? {}),
              ...(input.runnerId
                ? { [primarySessionName]: input.runnerId }
                : {}),
            }
          : undefined,
      projectFlow: { defaultRunnerId: projectFlowDefaultRunnerId },
      platformFlow: { defaultRunnerId: revision.defaultRunnerId },
      project: { defaultRunnerId: project.defaultRunnerId },
      platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
      runners: runnerCatalog,
    });

    runnerResolutionWarnings = sessionResolutions.flatMap((session) =>
      session.resolutionWarning
        ? [
            {
              sessionName: session.sessionName,
              warning: session.resolutionWarning,
            },
          ]
        : [],
    );

    for (const { sessionName, warning } of runnerResolutionWarnings) {
      log.warn(
        {
          runId,
          taskId: task.id,
          projectId: project.id,
          sessionName,
          slotKey: warning.slotKey,
          requested: warning.requested,
          launched: warning.launched,
        },
        "runner slot resolved with soft intent mismatch",
      );
    }

    // The run's `runs.*` runner columns mirror the primary session (expand phase —
    // they are dropped once every reader migrates to `run_sessions`, M42 #24).
    const runnerResolution =
      sessionResolutions.find(
        (session) => session.sessionName === primarySessionName,
      ) ?? sessionResolutions[0];
    const capabilityAgent = runnerResolution.capabilityAgent as CapabilityAgent;

    // ADR-166: re-check the local host with runner context (memoized 30 s;
    // a host that went away mid-resolution refuses here, before any worktree).
    try {
      await localHost({ db: _db as unknown as ExecutionDb });
    } catch (err) {
      log.warn(
        {
          taskId: task.id,
          projectId: project.id,
          runnerId: runnerResolution.runnerId,
          runnerResolutionTier: runnerResolution.runnerResolutionTier,
          reason: isMaisterError(err) ? err.details?.reason : undefined,
          message: err instanceof Error ? err.message : String(err),
        },
        "POST /api/runs supervisor readiness unavailable",
      );
      throw err;
    }

    // M11c (ADR-032): static settings-enforcement gate. Refuse the launch
    // BEFORE any worktree/run/workspace side-effect when any capability-bearing
    // (ai_coding/judge) node in the pinned manifest declares a `strict`
    // enforcement intent the resolved runner's agent cannot honor. The throw
    // propagates to errorResponse → httpStatusForCode: CONFIG→400 (the build
    // cannot enforce the class), EXECUTOR_UNAVAILABLE→503 (another agent could)
    // — the FROZEN SPEC mapping (docs/system-analytics/flow-settings.md §launch
    // -refusal). No worktree/run/workspace is created (we are before addWorktree).
    {
      // M13: active Flow-role registry (non-archived project_flow_roles).
      const projectRoleRows = await _db
        .select({ ref: projectFlowRoles.roleRef })
        .from(projectFlowRoles)
        .where(
          and(
            eq(projectFlowRoles.projectId, project.id),
            isNull(projectFlowRoles.archivedAt),
          ),
        );
      const activeFlowRoleRefs = new Set<string>(
        projectRoleRows.map((r: { ref: string }) => r.ref),
      );

      const skippedFlowRoleValidation = activeFlowRoleRefs.size === 0;

      assertCompiledFlowRolesLaunchable({
        compiled,
        activeRoleRefs: activeFlowRoleRefs,
        flowRefId: flow.flowRefId,
        projectSlug: project.slug,
      });

      // M14 carve-b: capability ref registry from the hydrated capability_records
      // catalog (DB mirror; maister.yaml is NOT re-read). Only non-disabled rows
      // count, so a CLEARed capability no longer resolves.
      const capRecordRows: CapabilityRefRecord[] = await _db
        .select({
          capabilityRefId: capabilityRecords.capabilityRefId,
          kind: capabilityRecords.kind,
          source: capabilityRecords.source,
        })
        .from(capabilityRecords)
        .where(
          and(
            eq(capabilityRecords.projectId, project.id),
            isNull(capabilityRecords.disabledAt),
          ),
        );
      const capabilityRefIds = capabilityRefIdSetsFromRecords(capRecordRows);

      let configuredNodes = 0;
      // M27/T-C8b: REQUIRED mcp refs (node settings.mcps.required ∪ package-level)
      // gathered for the agent-support refusal after the loop.
      const requiredMcpRefs = new Set<string>();

      for (const node of compiled.nodes.values()) {
        // M37 (ADR-098): an orchestrator inherits the ai_coding capability shape,
        // so its mcps/skills/restrictions refs are validated AND its `enforcement`
        // (e.g. strict mcps) is honored at launch exactly like ai_coding — without
        // this arm the orchestrator additions to enforcement.ts were dead code and
        // a strict orchestrator silently degraded to instructed.
        if (
          node.nodeType !== "ai_coding" &&
          node.nodeType !== "judge" &&
          node.nodeType !== "orchestrator"
        ) {
          continue;
        }
        configuredNodes += 1;

        const settings = capabilityBearingSettings(
          node.nodeType,
          node.settings,
        );

        for (const ref of normalizeNodeMcps(settings?.mcps).required) {
          requiredMcpRefs.add(ref);
        }

        // M14 carve-b: reject node settings.mcps/skills/restrictions/
        // settingsProfile refs absent from the project capability registry.
        const unknownCapability = firstUnknownCapabilityRef(
          node.nodeType,
          settings,
          capabilityRefIds,
        );

        if (unknownCapability !== null) {
          throw new MaisterError(
            "CONFIG",
            `node "${node.id}" unknown ${unknownCapability.kind} capability ref "${unknownCapability.ref}" not registered for project ${project.slug}`,
          );
        }

        assertNodeLaunchable(
          { id: node.id, nodeType: node.nodeType, settings },
          capabilityAgent,
        );
        // ADR-130 (DES-6): refuse a strict tools/mcps launch BEFORE run creation
        // when the resolved adapter lacks cached capabilityEnforcement smoke
        // evidence (EXECUTOR_UNAVAILABLE), OR uses dangerously_skip_permissions
        // (the seam is structurally inert under skip-perms → never a false-enforce).
        await assertEnforcementEvidence({
          settings,
          agent: capabilityAgent,
          permissionPolicy: runnerResolution.runnerSnapshot.permissionPolicy,
        });
      }

      // M27/T-C6 (C6-top, ADR-070): reject package-level required MCP refs
      // (manifest top-level `mcps`) absent from the project registry — after the
      // per-node M14 cap-ref check, before any side-effect. The
      // known-but-unmaterializable required-MCP refusal is T-C8.
      const unknownPackageMcp = firstUnknownPackageMcpRef(
        manifest.mcps,
        capabilityRefIds.mcp,
      );

      if (unknownPackageMcp !== null) {
        throw new MaisterError(
          "CONFIG",
          `flow "${flow.flowRefId}" declares unknown required mcp capability ref "${unknownPackageMcp}" not registered for project ${project.slug}`,
        );
      }

      for (const ref of manifest.mcps ?? []) {
        requiredMcpRefs.add(ref);
      }

      // ADR-130 (W-B): project MCP bindings redirect which record is the winner
      // for a ref (enabled binding beats precedence; disabled = unresolvable).
      // Loaded once here; reused by the agent-support gate and the launch
      // snapshot. Absent = grandfather (unchanged). Thread the caller's `_db`
      // (never getDb()) so a transaction / injected test connection is honored.
      const mcpBindings = await loadProjectMcpBindings(
        project.id,
        _db as never,
      );

      // M27/T-C8b (mcp-management §6.2, bullet 6): a REQUIRED mcp whose resolved
      // winner record does not support the executor agent cannot materialize →
      // refuse launch (EXECUTOR_UNAVAILABLE → 503), before any side-effect.
      // ADDITIONAL mcps degrade gracefully at materialization (non-fatal).
      if (requiredMcpRefs.size > 0) {
        // ADR-130 (W-B): a REQUIRED ref that has been explicitly disconnected
        // (disabled binding) is unresolvable — refuse launch naming the reconnect,
        // before any side-effect. CONFIG (422/409), not a silent drop.
        const disconnectedRequired = [...requiredMcpRefs].find((ref) =>
          mcpBindings.some((b) => b.refId === ref && !b.enabled),
        );

        if (disconnectedRequired) {
          throw new MaisterError(
            "CONFIG",
            `required mcp "${disconnectedRequired}" is disconnected for project ${project.slug} — reconnect it in Project → MCPs`,
          );
        }

        const mcpAgentRows = await _db
          .select({
            capabilityRefId: capabilityRecords.capabilityRefId,
            source: capabilityRecords.source,
            agents: capabilityRecords.agents,
          })
          .from(capabilityRecords)
          .where(
            and(
              eq(capabilityRecords.projectId, project.id),
              eq(capabilityRecords.kind, "mcp"),
              isNull(capabilityRecords.disabledAt),
            ),
          );

        const unsupportedMcp = firstAgentUnsupportedRequiredMcp(
          [...requiredMcpRefs],
          mcpAgentRows,
          capabilityAgent,
          mcpBindings,
        );

        if (unsupportedMcp !== null) {
          throw new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            `required mcp "${unsupportedMcp}" cannot materialize for executor agent ${capabilityAgent} in project ${project.slug} — bind or configure it in Project → MCPs`,
          );
        }
      }

      log.info(
        {
          taskId: task.id,
          flowRefId: flow.flowRefId,
          runnerId: runnerResolution.runnerId,
          runnerResolutionTier: runnerResolution.runnerResolutionTier,
          capabilityAgent,
          capabilityNodes: configuredNodes,
          platformRunners: runnerCatalog.length,
          projectFlowRoles: activeFlowRoleRefs.size,
          skippedFlowRoleValidation,
        },
        skippedFlowRoleValidation
          ? "[FIX:M13] POST /api/runs settings-enforcement gate passed with empty Flow role registry"
          : "POST /api/runs settings-enforcement gate passed",
      );
    }

    const worktreeRoot = worktreesRoot();
    const worktreePath =
      scheduledReservation?.worktreePath ??
      path.join(worktreeRoot, project.slug, runId);

    if (
      scheduledReservation &&
      scheduledReservation.worktreePath !==
        path.join(worktreeRoot, project.slug, scheduledReservation.runId)
    ) {
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch reservation has an invalid worktree identity",
      );
    }

    // M18 §3.1: branch targeting. Saved task defaults sit between launch input
    // and project defaults; target defaults to the resolved base. Both resolved
    // refs are validated against the project's real branch set (server-state
    // allow-list) BEFORE any git side-effect — an unknown branch is a
    // PRECONDITION refusal and no worktree is created.
    const base =
      input.baseBranch ??
      (task.baseBranch as string | null) ??
      project.mainBranch;
    const target =
      input.targetBranch ??
      input.deliveryPolicy?.targetBranch ??
      (task.targetBranch as string | null) ??
      base;
    const deliveryPolicy = resolveDeliveryPolicy({
      projectDefault:
        project.deliveryPolicyDefault as StoredDeliveryPolicy | null,
      projectPromotionMode: project.promotionMode,
      projectMainBranch: project.mainBranch,
      launchOverride: {
        ...input.deliveryPolicy,
        targetBranch: target,
      },
    });

    // Refresh origin (read-only: updates remote-tracking refs, never the working
    // tree) so the branch allow-list and the base commit reflect the freshest
    // remote state. Best-effort — offline / no origin is advisory, the launch
    // continues from whatever refs exist locally.
    try {
      const remotes = await listProjectRemotes(project.repoPath);

      if (remotes.some((r) => r.name === "origin")) {
        await fetchProjectRemote({
          project: { id: project.id, repoPath: project.repoPath },
          name: "origin",
        });
      }
    } catch (err) {
      log.warn(
        { taskId: task.id, err: (err as Error).message },
        "pre-launch origin fetch failed (advisory)",
      );
    }

    const knownBranches = new Set(
      await listBranches(project.repoPath, { includeRemotes: true }),
    );

    if (!knownBranches.has(base)) {
      throw new MaisterError(
        "PRECONDITION",
        `base branch "${base}" does not exist in ${project.slug}`,
      );
    }
    if (!knownBranches.has(target)) {
      throw new MaisterError(
        "PRECONDITION",
        `target branch "${target}" does not exist in ${project.slug}`,
      );
    }

    const requestedBaseCommit = input.baseCommit;
    const baseCommit =
      requestedBaseCommit === undefined
        ? await resolveBaseCommit({
            projectRepoPath: project.repoPath,
            baseRef: base,
            // Fork from origin/<base> when present (just fetched) so runs start from
            // the freshest remote state, not a stale local checkout; falls back to the
            // local <base>.
            preferRemote: "origin",
          })
        : await assertPinnedBaseCommitReachable({
            projectId: project.id,
            taskId: task.id,
            projectRepoPath: project.repoPath,
            baseRef: base,
            baseCommit: requestedBaseCommit,
          });
    const promotionMode: PromotionMode =
      deliveryPolicy.strategy === "ai_rebase_merge"
        ? "rebase_merge"
        : legacyPromotionModeFromStrategy(deliveryPolicy.strategy);

    // ADR-119: atomic attempt-number allocation — the SOLE writer of
    // attempt_number (the main launch tx no longer writes it; a slower concurrent
    // launch would otherwise clobber a higher value). The row-level UPDATE
    // serializes concurrent force-launches → DISTINCT attempt numbers ⇒ distinct
    // branches ⇒ no `git worktree add -b` collision. Deferred to AFTER every
    // cheap precondition (branch allow-list, base-commit resolution) so a
    // validation refusal NEVER burns a number — the only remaining gap is the
    // irreducible addWorktree/tx window below (a genuine git/db failure), where a
    // burned number is an acceptable monotonic-counter gap.
    const allocatedAttempt = scheduledReservation
      ? null
      : await _db
          .update(tasks)
          .set({ attemptNumber: sql`${tasks.attemptNumber} + 1` })
          .where(eq(tasks.id, task.id))
          .returning({ attemptNumber: tasks.attemptNumber });
    const newAttempt = scheduledReservation
      ? scheduledReservation.taskAttemptNumber
      : (allocatedAttempt?.[0]?.attemptNumber as number | undefined);

    if (newAttempt === undefined || newAttempt < 1) {
      throw new MaisterError("PRECONDITION", "run attempt allocation failed");
    }
    if (scheduledReservation && scheduledReservation.taskId !== task.id) {
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch reservation belongs to a different task",
      );
    }

    const branch =
      scheduledReservation?.branch ??
      `${project.branchPrefix}task-${task.id}/attempt-${newAttempt}`;

    if (
      scheduledReservation &&
      branch !== `${project.branchPrefix}task-${task.id}/attempt-${newAttempt}`
    ) {
      throw new MaisterError(
        "PRECONDITION",
        "scheduled launch reservation has an invalid branch identity",
      );
    }

    log.debug(
      { runId, taskId: task.id, attempt: newAttempt, branch },
      "[runs.launch] allocated attempt",
    );

    log.info(
      {
        taskId: task.id,
        runId,
        createdByUserId: ctx.actorUserId,
        runnerId: runnerResolution.runnerId,
        runnerResolutionTier: runnerResolution.runnerResolutionTier,
        capabilityAgent,
        branch,
        worktreePath,
      },
      "POST /api/runs preconditions ok",
    );
    log.debug(
      { runId, base, target, baseCommit, promotionMode, deliveryPolicy },
      "POST /api/runs branch targeting resolved",
    );

    // Every precondition has passed; the route turns this first yield into the
    // signal to start streaming (a throw above here is still a JSON error).
    yield launchProgress("precondition");

    await ctx.assertLaunchOwnership?.(_db);

    // Create the worktree BEFORE the DB transaction so a git failure
    // (branch already exists, dirty parent repo, missing path) does
    // NOT leave the task stuck in InFlight with an orphan run/workspace
    // row. The task stays in Backlog and is launchable again. The worktree
    // forks from the resolved base commit (M18 startPoint), not parent HEAD.
    await addWorktree({
      projectRepoPath: project.repoPath,
      branch,
      worktreePath,
      startPoint: baseCommit,
      provenance: {
        version: 2,
        runId,
        parentRepoPath: project.repoPath,
        projectId: project.id,
        branch,
        workspaceKind: "flow",
        createdAt: new Date().toISOString(),
        task: `${project.taskKey}-${task.number}`,
        flow: `${flow.flowRefId}@${revision.resolvedRevision}`,
      },
    });
    yield launchProgress("worktree_created");
    createdWorktreePath = worktreePath;

    // The worktree now exists; this nested try compensates it (removeWorktree) on any
    // failure through the run-insert. The pin is compensated by the outer catch.
    try {
      // M27/T-C8 (§7.1.8): freeze the resolved capability set onto the run so an
      // edit/publish mid-run cannot mutate it. flowOrigin: authored installs use a
      // local filesystem source (the bridge temp dir); git installs use a remote ref.
      const snapshotRecords = (await _db
        .select({
          capabilityRefId: capabilityRecords.capabilityRefId,
          kind: capabilityRecords.kind,
          source: capabilityRecords.source,
          revision: capabilityRecords.revision,
        })
        .from(capabilityRecords)
        .where(
          and(
            eq(capabilityRecords.projectId, project.id),
            isNull(capabilityRecords.disabledAt),
          ),
        )) as Array<{
        capabilityRefId: string;
        kind: string;
        source: string;
        revision: string | null;
      }>;
      // ADR-130 (W-B): thread bindings into the frozen snapshot so mcps[] records
      // provenance and the bound target wins over precedence. Uses the caller's
      // `_db` (never getDb()) for transaction / injected-connection correctness.
      const snapshotMcpBindings = await loadProjectMcpBindings(
        project.id,
        _db as never,
      );
      const resolvedCapabilitySet = buildResolvedCapabilitySet({
        records: snapshotRecords,
        flowRevisionId: revision.id,
        flowOrigin: revision.source?.startsWith("/") ? "authored" : "git",
        mcpBindings: snapshotMcpBindings,
      });

      log.debug(
        {
          runId,
          flowRevisionId: revision.id,
          flowOrigin: resolvedCapabilitySet.flowOrigin,
          capabilityCount: resolvedCapabilitySet.capabilities.length,
          mcpCount: resolvedCapabilitySet.mcps.length,
        },
        "[service.runs] resolved capability set snapshot built",
      );

      // Cancel here (pre-commit) compensates the worktree via the inner catch.
      opts.signal?.throwIfAborted();
      yield launchProgress("materializing", capabilityAgent);
      // Deliver AIF capability bundles into the fresh worktree's .claude/ and
      // write the per-run .ai-factory/config.yaml git-ownership override. Gated
      // on >=1 Installed import so non-AIF projects never get a stray config.
      // A failure here lands in the catch below → worktree compensation + abort.
      // Extracted to a reusable helper (ADR-079 §4) — fresh-attempt rewinds and
      // the ADR-082 dirty discard re-run it after `git clean -fd`.
      const { bundles } = await materializeProjectBundlesIntoWorktree({
        projectId: project.id,
        worktreePath,
        baseBranch: base,
        db: _db,
      });

      if (bundles > 0) {
        log.info(
          { runId, worktreePath, bundles, baseBranch: base },
          "[capabilities] materialized capability bundles + AIF config override into worktree",
        );
      }

      // Codex-1 (C): pre-write the recipe's frozen form inputs BEFORE the run
      // row exists — the runner cannot start before the insert + tryStartRun,
      // so a form node never races its pre-answer; a write failure lands in
      // the catch below (worktree compensation, no orphaned Pending run).
      if (input.evaluationFormInputs) {
        await writeEvaluationFormInputs({
          compiled,
          flowInstallPath: revision.installedPath,
          projectSlug: project.slug,
          runId,
          formValues: input.evaluationFormInputs,
        });
        log.info(
          { runId, fields: Object.keys(input.evaluationFormInputs).length },
          "[FIX:codex-1] controlled-recipe form inputs pre-written",
        );
      }

      await _db.transaction(async (tx: any) => {
        await ctx.assertLaunchOwnership?.(tx);

        // ADR-163: for a DELEGATED child the fan-out/depth bound is decided
        // HERE — in the same transaction as the run INSERT and under the
        // per-orchestrator advisory lock — so the count provably includes every
        // committed sibling and two racers cannot both insert. The delegation
        // seam's own pre-check is a fast path that avoids minting a carrier task
        // and a worktree for an obviously over-cap request; it is never the
        // decision. No-op for every board / scheduled launch (no parentRunId).
        if (input.parentRunId) {
          await admitDelegatedChild(tx, { parentRunId: input.parentRunId });
        }

        // `runs` first: `workspaces.run_id` is a non-deferrable FK to `runs.id`,
        // so the workspace insert would violate it if it ran first.
        const insertedRun = await tx
          .insert(runs)
          .values({
            id: runId,
            executionDataPlaneMode,
            taskId: task.id,
            projectId: project.id,
            flowId: flow.id,
            // M42 (ADR-114): the runner identity + resume handle live on
            // `run_sessions` (inserted below), not the runs row.
            resolvedCapabilitySet,
            deliveryPolicySnapshot: deliveryPolicy,
            executionPolicy,
            // ADR-126 T10: launch opt-out persists as a `launch`-sourced hold so
            // the sweep never considers this run (survives rework like any hold).
            // ADR-146 D15: a launched evaluation participant (controlled launch
            // via `evaluationStudyId`, or a restart inheriting participation)
            // gets the FORCED `evaluation_study` hold instead — the DELETE hold
            // route refuses to clear it while the owning study is live.
            promotionHold: evaluationHoldStudyId
              ? {
                  source: "evaluation_study" as const,
                  reason: `launched evaluation participant (study ${evaluationHoldStudyId})`,
                  createdAt: new Date().toISOString(),
                }
              : input.autoPromote === false
                ? {
                    source: "launch" as const,
                    createdAt: new Date().toISOString(),
                  }
                : null,
            // M39 (ADR-106): the driving agent of an agent-driven flow run (null for
            // a normal board launch). The graph runner reads it to inject the
            // agent's persona on every ai_coding node.
            agentId: input.agentId ?? null,
            // M39 (ADR-106): trigger provenance for an agent-driven flow run. The
            // partial unique (agent_id, trigger_event_id) index is the race backstop
            // for a CONCURRENT redelivery (the sequential one is caught by
            // launchAgentRun's pre-check); onConflictDoNothing turns the loser into a
            // clean CONFLICT (the catch below compensates the worktree) instead of a
            // raw 23505. A board launch carries no trigger_event_id ⇒ never conflicts.
            triggerSource: scheduledReservation
              ? "scheduled"
              : (input.triggerSource ?? null),
            triggerEventId: input.triggerEventId ?? null,
            triggerPayload: input.triggerPayload ?? null,
            scheduledLaunchId: scheduledReservation?.scheduledLaunchId ?? null,
            agentScheduleId: input.agentScheduleId ?? null,
            // ADR-150: the controlled-launch idempotency handle. The partial
            // UNIQUE `runs_evaluation_batch_item_uq` makes a re-driven batch item
            // hit onConflictDoNothing → the empty-insert branch below ADOPTS the
            // existing run instead of minting a second.
            evaluationBatchItemId: input.evaluationBatchItemId ?? null,
            createdByUserId: ctx.actorUserId,
            // ADR-121 (INV-9): auto-drain origin marker, set ONLY for runs minted
            // by the unified admission funnel.
            queueAdmittedAt: input.queueAdmitted ? new Date() : null,
            // ADR-122 (T5.3): persist the launch-time ambient-brain decision.
            // null = inherit the flow default at ambient-inject time (T4.3).
            brainContext: input.brainContext ?? null,
            // ADR-163: run-tree linkage + the launch-time delegation snapshot
            // for a delegated flow child. All four are written in THIS insert,
            // so a child is never briefly parentless; every terminal and
            // recovery path reads the snapshot rather than a live projection
            // that may have moved since.
            parentRunId: input.parentRunId ?? null,
            rootRunId: input.rootRunId ?? null,
            launchMode: input.launchMode ?? null,
            // D7: the launcher completes the flow snapshot with the branch
            // pair IT resolved, so the snapshot and `workspaces` can never
            // disagree about what this child branched from and promotes into.
            // Codex review F4: the same rule for the revision — the caller's
            // resolve and this one are separated by a committed transaction
            // and a supervisor round-trip, so the snapshot mirrors the
            // `revision` selected HERE, never a pin the caller took earlier.
            delegationSnapshot: input.delegationSnapshot
              ? {
                  ...input.delegationSnapshot,
                  flowRevisionId: revision.id,
                  resolvedRevision: revision.resolvedRevision,
                  engineMin: revision.engineMin ?? null,
                  engineMax: revision.engineMax ?? null,
                  baseBranch: base,
                  targetBranch: target,
                }
              : null,
            status: "Pending",
            // Snapshot the enabled revision (M10, ADR-021). flow_revision_id is
            // the authoritative pin the runner resolves the manifest + bundle
            // path from; the version/SHA text columns remain for display and the
            // legacy fallback. A later upgrade/rollback changes the project's
            // enabled revision but this run stays pinned to what it launched with.
            flowVersion: revision.versionLabel,
            flowRevision: revision.resolvedRevision,
            flowRevisionId: revision.id,
            // ADR-165: the launch-time public-result contract, written in the
            // SAME insert as the pin it came from (W8). NULL when the flow
            // declares no `result.export`.
            resultContract,
          })
          .onConflictDoNothing()
          .returning({ id: runs.id });

        // A concurrent redelivery lost the (agent_id, trigger_event_id) claim — the
        // run already exists. Surface a typed CONFLICT (the catch compensates the
        // worktree); never a raw 23505 → 500. Board launches never reach here.
        if (insertedRun.length === 0) {
          // ADR-150: a controlled-launch re-drive lost the
          // `runs_evaluation_batch_item_uq` claim — the winner already launched
          // this batch item. ADOPT it: return the existing run so the seam's
          // launchKey is idempotent (never a second run), and signal the caller
          // to compensate this attempt's orphan worktree. Checked BEFORE the
          // trigger-event/scheduled throws so a batch launch never mis-reports.
          if (input.evaluationBatchItemId) {
            const [winner] = await tx
              .select({ id: runs.id })
              .from(runs)
              .where(
                eq(runs.evaluationBatchItemId, input.evaluationBatchItemId),
              );

            if (winner) {
              adoptedRunId = winner.id;

              return;
            }
          }

          if (scheduledReservation) {
            throw new MaisterError(
              "CONFLICT",
              "scheduled launch already has a linked Run",
            );
          }

          throw new MaisterError(
            "CONFLICT",
            `trigger event ${input.triggerEventId} already claimed for agent ${input.agentId}`,
          );
        }

        // ADR-146 D15: the SUCCESSOR participant row for a restarted launched
        // evaluation participant — same study/recipe lineage, the NEW runId, so
        // `isLaunchedLineageRun(newRun)` holds the replacement. The fresh runId
        // never collides with the live (study_id, run_id) partial unique (the
        // dead run's row stays, immutably holding the dead run); `batch_item_id`
        // stays null (the partial-unique adoption anchor binds the ORIGINAL
        // batch launch to its first participant). A tombstoned source mirrors
        // its removed state — the replacement is held without re-surfacing as a
        // live study participant. `budget_restart` maps to `manual_relaunch`
        // (the participant launch_reason enum; same mapping as backfill 0110).
        if (inheritedEvaluationParticipation) {
          await tx.insert(evaluationParticipants).values({
            id: randomUUID(),
            studyId: inheritedEvaluationParticipation.studyId,
            runId,
            sourceType: "launched",
            recipeId: inheritedEvaluationParticipation.recipeId,
            label: inheritedEvaluationParticipation.label,
            replicateGroup: inheritedEvaluationParticipation.replicateGroup,
            replicateOrdinal: inheritedEvaluationParticipation.replicateOrdinal,
            launchReason: "manual_relaunch",
            runIdentity: {
              runId,
              taskId: task.id,
              flowRefId: flow.flowRefId,
              flowRevisionId: revision.id,
              capturedAt: new Date().toISOString(),
            },
            ...(inheritedEvaluationParticipation.sourceRemoved
              ? { removedAt: new Date() }
              : {}),
          });
        }

        // M42 (ADR-114): one `run_sessions` row per resolved session — the SOLE
        // source of truth for which host runner each logical session runs on.
        // Inserted in the SAME transaction as `runs` (atomic: a crash before
        // commit leaves no run; the sweep recovers a commit-without-spawn).
        await tx.insert(runSessions).values(
          sessionResolutions.map((session) => ({
            id: randomUUID(),
            runId,
            sessionName: session.sessionName,
            runnerId: session.runnerId,
            runnerResolutionTier: session.runnerResolutionTier,
            capabilityAgent: session.capabilityAgent,
            runnerSnapshot: session.runnerSnapshot,
            acpSessionId: null,
            resolutionSource: session.resolutionSource,
            resolutionWarning: session.resolutionWarning ?? null,
          })),
        );

        // ADR-166 D3: epoch 1 of the run's driver ownership, in the SAME tx as
        // the run (no run ⇒ no assignment). Insert branch only — the ADR-150
        // adopted-run branch returned above without inserting anything.
        await mintPlacement(tx as unknown as ExecutionDb, {
          runId,
          reason: "launch",
          host: placementHost,
        });

        if (requiresLaunchUnattended(executionPolicy)) {
          logExecPolicyAction({
            runId,
            kind: "launched",
            detail: {
              preset: executionPolicy.preset,
              overrides: executionPolicy.overrides ?? {},
            },
          });
        }

        await tx.insert(workspaces).values({
          id: randomUUID(),
          runId,
          projectId: project.id,
          branch,
          worktreePath,
          parentRepoPath: project.repoPath,
          baseBranch: base,
          baseCommit,
          targetBranch: target,
          promotionMode,
        });
        // ADR-119: attempt_number is allocated atomically up-front (sole writer);
        // the main tx only flips the one-way status latch. For a concurrent
        // relaunch the task is already InFlight, so this set is an idempotent
        // no-op (no real status flip) while the run_launched activity below still
        // fires per launch (each launch is a real creation event).
        await tx
          .update(tasks)
          .set({
            status: "InFlight",
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));

        // ADR-078 D7: run_launched is the activity for the only real
        // task-status transition (the launch flip), written in the same tx.
        // Scheduler fires pass actorUserId: null ⇒ system actor.
        await recordTaskActivity(tx, {
          taskId: task.id,
          projectId: project.id,
          actor: actorForUserId(ctx.actorUserId),
          eventKind: "run_launched",
          payload: { runId, attemptNumber: newAttempt },
        });

        await ctx.recordSuccessAudit?.(tx);
      });
    } catch (err) {
      // Inner: a failure after the worktree was created. Remove the orphan worktree
      // so the next launch can recreate the same branch+path without a PRECONDITION
      // "already exists". The pin is re-pinned by the outer catch on rethrow.
      log.warn(
        { runId, err: (err as Error).message },
        "launch setup failed after addWorktree — removing worktree",
      );
      await removeWorktree({
        projectRepoPath: project.repoPath,
        worktreePath,
        force: true,
      }).catch((rmErr) =>
        log.error(
          { rmErr: (rmErr as Error).message, worktreePath },
          "compensating removeWorktree failed (manual cleanup may be required)",
        ),
      );
      throw err;
    }
  } catch (err) {
    // Outer (ADR-107): any failure after the adopt re-pins the advanced
    // attachment(s), so a failed launch never leaves the shared project pin moved.
    // Best-effort; a revert failure logs but never masks the original error.
    await revertPackageVersionChoices(adoptReverts, {
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      db: _db as never,
    });
    throw err;
  }

  // ADR-150: this attempt lost the batch-item claim and adopted the winner's
  // run. Nothing was inserted for `runId`, but its fresh unique worktree is an
  // orphan (safe to remove — the path is `<slug>/<runId>`, never the winner's).
  // Skip start (the adopted run is already driving) and return it.
  if (adoptedRunId) {
    if (createdWorktreePath) {
      await removeWorktree({
        projectRepoPath: project.repoPath,
        worktreePath: createdWorktreePath,
        force: true,
      }).catch((rmErr) =>
        log.error(
          {
            rmErr: (rmErr as Error).message,
            worktreePath: createdWorktreePath,
          },
          "adopt-path compensating removeWorktree failed (manual cleanup may be required)",
        ),
      );
    }

    return { runId: adoptedRunId, status: "Pending" };
  }

  await appendRunnerResolutionWarningEvents({
    db: _db as ExecutionDb,
    runId,
    projectSlug: project.slug,
    taskId: task.id,
    warnings: runnerResolutionWarnings,
  });

  if (input.parentRunId) {
    log.info(
      {
        runId,
        taskId: task.id,
        parentRunId: input.parentRunId,
        rootRunId: input.rootRunId ?? null,
        launchMode: input.launchMode ?? null,
      },
      "[delegation.launch] flow run launched as delegated child",
    );
  }

  const startResult = await tryStartRun(runId, { db: _db });

  if (startResult.started) {
    void runFlow(runId).catch((err: unknown) =>
      log.error(
        { err: (err as Error).message, runId },
        "background runFlow failed",
      ),
    );

    return { runId, status: "Running" };
  }

  return { runId, status: "Pending", queuePosition: startResult.queuePosition };
}

// Back-compat drain: non-streaming callers (the non-SSE route path, scheduler
// fires, tests) get a Promise with the same behavior they relied on before T6.3.
export async function launchRun(
  input: LaunchRunInput,
  ctx: LaunchRunContext,
  db?: Db,
): Promise<{ runId: string; status: string; queuePosition?: number }> {
  const gen = launchRunStaged(input, ctx, db);
  let step = await gen.next();

  while (!step.done) step = await gen.next();

  return step.value;
}

// ADR-141: the latest branch-sync attempt projection, matching the OpenAPI
// `RunDTO.syncAttempt` wire schema (docs/api/external/operations.openapi.yaml).
export type RunSyncAttemptDTO = {
  attempt: number;
  strategy: "rebase" | "merge";
  mode: "mechanical" | "agent";
  phase: string;
  pushed: boolean;
  errorCode: string | null;
};

export type RunDTO = {
  id: string;
  taskId: string | null;
  projectId: string;
  status: string;
  flowId: string | null;
  // Pre-existing wire naming: the OpenAPI documents this as `executorId`. The
  // ext route serializes this object verbatim; do not rename here.
  runnerId: string;
  currentStepId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  // ADR-140 PR lifecycle: provider PR state + conflict flag from the workspace.
  prState: "open" | "merged" | "closed" | null;
  prHasConflicts: boolean | null;
  // ADR-141: the latest branch-sync attempt (by `attempt` desc), null when none.
  syncAttempt: RunSyncAttemptDTO | null;
};

export async function getRunDTO(
  runId: string,
  projectId: string,
  db?: Db,
): Promise<RunDTO | null> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = await (_db as any)
    .select({
      id: runs.id,
      taskId: runs.taskId,
      projectId: runs.projectId,
      status: runs.status,
      flowId: runs.flowId,
      runnerId: activeSessionRunnerId(runs.id),
      currentStepId: runs.currentStepId,
      startedAt: runs.startedAt,
      finishedAt: runs.endedAt,
      prState: workspaces.prState,
      prHasConflicts: workspaces.prHasConflicts,
    })
    .from(runs)
    .leftJoin(workspaces, eq(workspaces.runId, runs.id))
    .where(and(eq(runs.id, runId), eq(runs.projectId, projectId)));

  if (rows.length === 0) return null;

  const row = rows[0];

  const syncRows = await (_db as any)
    .select({
      attempt: runSyncAttempts.attempt,
      strategy: runSyncAttempts.strategy,
      mode: runSyncAttempts.mode,
      phase: runSyncAttempts.phase,
      pushed: runSyncAttempts.pushed,
      errorCode: runSyncAttempts.errorCode,
    })
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.runId, runId))
    .orderBy(desc(runSyncAttempts.attempt))
    .limit(1);
  const sync = syncRows[0];

  return {
    id: row.id,
    taskId: row.taskId ?? null,
    projectId: row.projectId,
    status: row.status,
    flowId: row.flowId ?? null,
    runnerId: row.runnerId,
    currentStepId: row.currentStepId ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    prState: row.prState ?? null,
    prHasConflicts: row.prHasConflicts ?? null,
    syncAttempt: sync
      ? {
          attempt: sync.attempt,
          strategy: sync.strategy,
          mode: sync.mode,
          phase: sync.phase,
          pushed: sync.pushed,
          errorCode: sync.errorCode ?? null,
        }
      : null,
  };
}
