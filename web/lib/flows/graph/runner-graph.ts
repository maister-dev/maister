import "server-only";

import type {
  MaterializationPlan,
  Run as RunRow,
  ScratchAdapterLaunch,
} from "@/lib/db/schema";
import type { CapabilityCatalogRecord } from "@/lib/capabilities/types";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type {
  FormSettings,
  RetryPolicy,
  SessionPolicy,
} from "@/lib/config.schema";
import type { AcpSessionState, FlowContext, StepResult } from "../types";
import type { SupervisorApi } from "../runner-agent";
import type { CompiledNode } from "./compile";
import type { Db, LoadedRun, RunFlowOptions } from "./runner-core";

import { randomUUID } from "node:crypto";
import { access, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { and, desc, eq, isNotNull } from "drizzle-orm";
import pino from "pino";

import { buildContext } from "../context";
import { runAgentStep } from "../runner-agent";
import { runCliStep } from "../runner-cli";

import { cleanupSlashSession, asError } from "./runner-core";
import { compileManifest, resolveTransition } from "./compile";
import { runNodeGates } from "./gates-exec";
import { validateNodeStructuredOutput } from "./node-output";
import {
  appendNodeAttempt,
  getNodeAttemptsForRun,
  hasPendingTakeoverResume,
  latestAttemptForNode,
  markDownstreamStale,
  markNodeFailed,
  markNodeNeedsInput,
  markNodeReworked,
  markNodeRunning,
  markNodeSucceeded,
  setCheckpointRef,
  setEnforcementSnapshot,
  setMaterializationPlan,
  setSessionFallback,
} from "./ledger";
import {
  applyWorkspacePolicy,
  captureCheckpoint,
  deleteRunCheckpointRefs,
} from "./workspace-checkpoint";
import { resolveSessionPolicy } from "./session-policy";
import {
  failArtifact,
  getCurrentArtifact,
  getArtifactsForRun,
  recordArtifact,
  recordCurrentArtifact,
} from "./artifact-store";
import { recordDefaultArtifacts } from "./default-artifacts";
import { assertEvidenceReady } from "./evidence-readiness";
import {
  captureNodeStartHead,
  resolveDiffRange,
  restrictionPathSets,
  type RestrictionPathSet,
} from "./mutation-check";

import { gateStdioMcpsByExecTrust } from "@/lib/capabilities/agent-map";
import { materializeProjectBundlesIntoWorktree } from "@/lib/capabilities/materialize-bundle";
import {
  mergeRunnerAdapterLaunch,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import {
  readAndValidateFormSchemaDoc,
  validateFormSchemaVersion,
} from "@/lib/config";
import { semverGte } from "@/lib/flows/engine-version";
import {
  assertNodeLaunchable,
  capabilityBearingSettings,
  evaluateNodeEnforcement,
} from "@/lib/flows/enforcement";
import {
  loadSelectableCapabilities,
  pinCatalogToSnapshot,
  resolveCapabilityProfile,
} from "@/lib/capabilities/resolver";
import { materializeCapabilityProfile } from "@/lib/capabilities/materialize";
import { cleanupNodeMaterialization } from "@/lib/capabilities/cleanup";
import { atomicWriteJson } from "@/lib/atomic";
import {
  createHitlAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { headCommit, resolveBaseRef, resolveRefSha } from "@/lib/worktree";
import {
  allNodeMcpRefs,
  workspacePolicySchema,
  type WorkspacePolicy,
} from "@/lib/config.schema";
import { projectRunEvents } from "@/lib/projector/artifact-projector";
import {
  compareThreadReplies,
  compareThreadRoots,
} from "@/lib/review-comments/order";
import {
  composeReworkPayload,
  type ComposeRootComment,
  type ComposeThread,
} from "@/lib/review-comments/serialize";
import { promoteNextPending } from "@/lib/scheduler";
import { deliverRunIfAutoReady } from "@/lib/runs/auto-delivery";
import {
  dirtyResolveFromSnapshot,
  humanGateFromSnapshot,
  onStuckFromSnapshot,
  permissionsFromSnapshot,
  resolveHumanGateDisposition,
  reworkExhaustionFromSnapshot,
} from "@/lib/runs/execution-policy";
import { autoResolveDirtyAtReview } from "@/lib/runs/dirty-resolution";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import {
  isMaisterError,
  MaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, hitlRequests, reviewComments, gateChatMessages } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-runner-graph",
  level: process.env.LOG_LEVEL ?? "info",
});

type TransactionalDb = Db & {
  transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
};

// Hard backstop on total node executions per run — a defense beyond per-node
// rework.maxLoops so a misdeclared graph can never spin forever.
const HARD_NODE_EXECUTION_CEILING = 500;

// T4: the form_schema doc version this runner collects against.
const FORM_SCHEMA_VERSION = 1;

type NodeResult = StepResult & {
  needsInput?: boolean;
  acpSessionId?: string;
  decision?: string;
  workspacePolicy?: string;
  // M30 (ADR-081): the dispatch requested a resume but fell back to a fresh
  // session (gone/unresumable prior session).
  sessionFallback?: boolean;
};

function runDir(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): string {
  return path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

// `.for("update")` is a Postgres-only row lock; SQLite relies on its
// single-writer lock so the bare SELECT is correct there.
function isPostgres(): boolean {
  const url = process.env.DB_URL ?? "";

  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

async function tryReadInputArtifact(
  inputPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(inputPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    throw new MaisterError(
      "CONFIG",
      `input artifact at ${inputPath} is not a JSON object`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (isMaisterError(err)) throw err;
    throw new MaisterError(
      "CONFIG",
      `failed to read input artifact at ${inputPath}: ${asError(err).message}`,
      { cause: asError(err) },
    );
  }
}

// B3 (execution-policy onStuck): emit the run.escalated signal — the domain
// fact log (internal consumers / audit) + the outbound webhook (external
// notify). Best-effort notification: run.escalated drives no idempotent state
// transition, so it is not transactionally bound to the pause/ship write that
// follows.
async function emitRunEscalated(args: {
  db: Db;
  projectId: string;
  runId: string;
  taskId: string | null;
  nodeId: string;
  onStuck: "escalate" | "ship_with_warning" | "notify_only";
}): Promise<void> {
  await emitDomainEvent({
    db: args.db,
    kind: "run.escalated",
    projectId: args.projectId,
    runId: args.runId,
    taskId: args.taskId,
    actor: { type: "system", id: null },
    payload: { runId: args.runId, nodeId: args.nodeId, onStuck: args.onStuck },
  });
  await emitWebhookEvent({
    db: args.db,
    type: "run.escalated",
    projectId: args.projectId,
    runId: args.runId,
    data: { nodeId: args.nodeId, onStuck: args.onStuck },
  });
}

// Human review node: on resume read the operator's decision from the input
// artifact; on first visit create the review HITL (with the manifest-derived
// allow-list in `schema`) and pause. Full decision validation + rework
// staleness land in Phase 5; here the decision drives the pointer move.
export async function runReviewHuman(
  node: CompiledNode,
  loaded: LoadedRun,
  prompt: string,
  ctx: { runtimeRoot: string; db: Db; gateAttempt: number },
): Promise<NodeResult> {
  const startedAt = Date.now();
  const dir = runDir(ctx.runtimeRoot, loaded.projectSlug, loaded.run.id);
  const inputPath = path.join(dir, `input-${node.id}.json`);
  const existing = await tryReadInputArtifact(inputPath);

  if (existing) {
    // Consume the response artifact so a re-entered review node (after a
    // rework jump) pauses for a FRESH decision rather than re-reading the
    // stale one. The decision is durably recorded on the hitl_requests row;
    // this file is only the delivery channel.
    await unlink(inputPath).catch(() => {});

    const decisions = node.finishHuman?.decisions ?? [];
    const raw = existing.decision;
    const decision =
      typeof raw === "string" &&
      (decisions.length === 0 || decisions.includes(raw))
        ? raw
        : decisions[0];

    const allowedPolicies = node.rework?.workspacePolicies ?? [];
    const policyParsed = workspacePolicySchema.safeParse(
      existing.workspacePolicy,
    );
    const workspacePolicy: WorkspacePolicy =
      policyParsed.success &&
      (allowedPolicies.length === 0 ||
        allowedPolicies.includes(policyParsed.data))
        ? policyParsed.data
        : (allowedPolicies[0] ?? "keep");

    return {
      ok: true,
      stdout: "",
      vars: existing,
      durationMs: Date.now() - startedAt,
      needsInput: false,
      decision,
      workspacePolicy,
    };
  }

  // B2/B3 (execution-policy human-gate auto-pass + on-stuck routing): under the
  // `unattended` preset (humanGate=auto_pass), resolve this human gate WITHOUT a
  // human once Group-A machine review has passed (assertEvidenceReady). When it
  // cannot auto-pass (review not ready, or no safe-default decision), route per
  // the onStuck axis. Inert (the normal HITL pause) for supervised/assisted
  // (humanGate=stop) — fail-closed on a null/malformed policy snapshot.
  let assignHitl = true;
  const humanGate = humanGateFromSnapshot(loaded.run.executionPolicy ?? null);

  if (humanGate === "auto_pass") {
    // Safe-default = the forward (non-rework) decision (mirrors A.2's rule).
    const reworkTargets = node.rework?.allowedTargets ?? [];
    const safeDefault = (node.finishHuman?.decisions ?? []).find(
      (d) =>
        node.transitions[d] !== undefined &&
        !reworkTargets.includes(node.transitions[d]),
    );
    const evidenceReady =
      safeDefault !== undefined
        ? (await assertEvidenceReady(loaded.run.id, "review", ctx.db)).ready
        : false;
    const disposition = resolveHumanGateDisposition({
      humanGate,
      onStuck: onStuckFromSnapshot(loaded.run.executionPolicy ?? null),
      hasSafeDefault: safeDefault !== undefined,
      evidenceReady,
    });

    if (disposition.action === "auto_pass" && safeDefault !== undefined) {
      logExecPolicyAction({
        runId: loaded.run.id,
        kind: "human_gate_auto_passed",
        detail: { nodeId: node.id, decision: safeDefault },
      });
      log.info(
        { runId: loaded.run.id, nodeId: node.id, decision: safeDefault },
        "[human-gate.auto-pass] machine review ready → auto-resolved",
      );

      return {
        ok: true,
        stdout: "",
        vars: {},
        durationMs: Date.now() - startedAt,
        needsInput: false,
        decision: safeDefault,
      };
    }

    if (
      disposition.action === "ship_with_warning" &&
      safeDefault !== undefined
    ) {
      logExecPolicyAction({
        runId: loaded.run.id,
        kind: "escalated",
        detail: { nodeId: node.id, onStuck: "ship_with_warning" },
      });
      await emitRunEscalated({
        db: ctx.db,
        projectId: loaded.run.projectId,
        runId: loaded.run.id,
        taskId: loaded.run.taskId ?? null,
        nodeId: node.id,
        onStuck: "ship_with_warning",
      });
      log.info(
        { runId: loaded.run.id, nodeId: node.id, decision: safeDefault },
        "[on-stuck] ship_with_warning → forward past the human gate",
      );

      return {
        ok: true,
        stdout: "",
        vars: {
          execPolicyWarning:
            "shipped past an unresolved human gate (machine review not ready)",
        },
        durationMs: Date.now() - startedAt,
        needsInput: false,
        decision: safeDefault,
      };
    }

    // Pause route — escalate (assign a human) or notify_only (pause WITHOUT an
    // assignment: emit the signal, don't actively route to "Needs you").
    const notifyOnly =
      disposition.action === "pause" && disposition.assign === false;

    assignHitl = !notifyOnly;
    const onStuck = notifyOnly ? "notify_only" : "escalate";

    logExecPolicyAction({
      runId: loaded.run.id,
      kind: "escalated",
      detail: { nodeId: node.id, onStuck },
    });
    await emitRunEscalated({
      db: ctx.db,
      projectId: loaded.run.projectId,
      runId: loaded.run.id,
      taskId: loaded.run.taskId ?? null,
      nodeId: node.id,
      onStuck,
    });
  }

  // Server-state allow-list stored on the row at creation (Phase 5 validates
  // submissions against it). prompt is the rendered review ask.
  const schema = {
    review: true,
    allowedDecisions: node.finishHuman?.decisions ?? [],
    transitions: node.transitions,
    reworkTargets: node.rework?.allowedTargets ?? [],
    workspacePolicies: node.rework?.workspacePolicies ?? [],
    commentsVar:
      node.rework?.commentsVar ?? node.finishHuman?.commentsVar ?? null,
    // ADR-072 loop fields: gateAttempt is the 1-based visit number of THIS
    // gate (the current visit's attempt row is appended before the action
    // runs, so the ledger count equals the visit number); maxLoops is the
    // node's rework bound — null when the node declares no rework.
    maxLoops: node.rework?.maxLoops ?? null,
    gateAttempt: ctx.gateAttempt,
  };

  const needsInputPath = path.join(dir, "needs-input.json");

  await atomicWriteJson(needsInputPath, {
    nodeId: node.id,
    kind: "human_review",
    schema,
    prompt,
    requestedAt: new Date().toISOString(),
  });

  const hitlRequestId = randomUUID();
  const settingsRoleRefs =
    node.nodeType === "human" && node.settings && "roles" in node.settings
      ? (node.settings.roles ?? [])
      : [];
  const roleRefs = Array.from(
    new Set(
      [node.finishHuman?.role, ...settingsRoleRefs].filter(
        (role): role is string => typeof role === "string",
      ),
    ),
  );

  const nodeCriticality =
    node.nodeType === "human" &&
    node.settings !== undefined &&
    "criticality" in node.settings
      ? ((
          node.settings as {
            criticality?: "low" | "medium" | "high" | "critical";
          }
        ).criticality ?? null)
      : null;

  // M30 (ADR-082): stamp the run-branch tip at THIS review visit — the base
  // for the `since-last-review` diff scope. Best-effort (non-git fixtures /
  // missing workspace / detached states leave it NULL and the scope degrades).
  const reviewTipSha = loaded.workspace?.worktreePath
    ? await headCommit({ worktreePath: loaded.workspace.worktreePath }).catch(
        () => null,
      )
    : null;

  // C3 (execution-policy dirtyResolve): when pausing at a review gate, a policy
  // of commit/proceed auto-resolves a dirty worktree AT creation (no interactive
  // prompt) and records it on the HITL row; `ask` (supervised default) keeps the
  // banner; `discard` is NEVER automatic. Best-effort (git error → interactive).
  const dirtyResolution = await autoResolveDirtyAtReview({
    worktreePath: loaded.workspace?.worktreePath ?? null,
    policy: dirtyResolveFromSnapshot(loaded.run.executionPolicy ?? null),
    nodeId: node.id,
  });

  if (dirtyResolution) {
    logExecPolicyAction({
      runId: loaded.run.id,
      kind: "dirty_auto_resolved",
      detail: { nodeId: node.id, dirtyResolution },
    });
  }

  const persistHitlRequestAndAssignment = async (tx: Db): Promise<void> => {
    await tx.insert(hitlRequests).values({
      id: hitlRequestId,
      runId: loaded.run.id,
      stepId: node.id,
      kind: "human",
      schema,
      prompt,
      criticality: nodeCriticality,
      reviewTipSha,
      dirtyResolution,
    });
    log.debug(
      { runId: loaded.run.id, nodeId: node.id, criticality: nodeCriticality },
      "criticality resolved at creation",
    );
    // B3 notify_only (assignHitl=false): the HITL request row is still written
    // so a response CAN resolve the run, but no assignment is created and no
    // hitl.requested fires — the run pauses without routing to "Needs you" (the
    // run.escalated signal already notified externally).
    if (assignHitl) {
      await createHitlAssignmentForRun({
        db: tx,
        runId: loaded.run.id,
        hitlRequestId,
        nodeId: node.id,
        actionKind: "human_review",
        roleRefs,
        title: prompt,
      });
      await emitWebhookEvent({
        db: tx,
        type: "hitl.requested",
        projectId: loaded.run.projectId,
        runId: loaded.run.id,
        data: { hitlRequestId, kind: "human", nodeId: node.id },
      });
    }
  };

  try {
    if (
      typeof (ctx.db as { transaction?: unknown }).transaction === "function"
    ) {
      await (ctx.db as TransactionalDb).transaction(
        persistHitlRequestAndAssignment,
      );
    } else {
      await persistHitlRequestAndAssignment(ctx.db);
    }
  } catch (err) {
    await unlink(needsInputPath).catch((cleanupErr: unknown) => {
      log.error(
        {
          runId: loaded.run.id,
          nodeId: node.id,
          hitlRequestId,
          needsInputPath,
          err: asError(err).message,
          cleanupErr: asError(cleanupErr).message,
        },
        "[FIX:M13] failed to remove review needs-input.json after HITL assignment persistence failure",
      );
    });
    throw err;
  }

  log.info(
    { runId: loaded.run.id, nodeId: node.id, hitlRequestId, roleRefs },
    "[FIX:M13] review HITL assignment created — pausing NeedsInput",
  );

  return {
    ok: false,
    stdout: "",
    vars: {},
    durationMs: Date.now() - startedAt,
    needsInput: true,
  };
}

// T4: form intake node. Mirrors runReviewHuman's HITL/needs-input lifecycle but
// for a value-collection form: on first visit it reads+validates the node's
// `form_schema` doc, pauses with a `kind:"form"` HITL; on resume the submitted
// input artifact's object IS the node's output vars (no decision ⇒ the graph
// outcome resolves to "success", following `transitions.success`).
export async function runFormCollect(
  node: CompiledNode,
  loaded: LoadedRun,
  settings: FormSettings,
  ctx: { runtimeRoot: string; db: Db },
): Promise<NodeResult> {
  const startedAt = Date.now();
  const dir = runDir(ctx.runtimeRoot, loaded.projectSlug, loaded.run.id);
  const inputPath = path.join(dir, `input-${node.id}.json`);
  const existing = await tryReadInputArtifact(inputPath);

  if (existing) {
    // NOT unlinked here (unlike runReviewHuman): the submitted values become the
    // node's persisted output vars (markNodeSucceeded -> node_attempts.vars),
    // which is what downstream {{steps.<id>.vars.*}} reads — the file is never
    // re-read. A form node declares only transitions.success (no rework/on_reject
    // re-entry in the schema), so a stale artifact can't be re-consumed. If
    // on_reject is ever added to form nodes, this branch must unlink first.
    return {
      ok: true,
      stdout: "",
      vars: existing,
      durationMs: Date.now() - startedAt,
      needsInput: false,
    };
  }

  const schema = await readAndValidateFormSchemaDoc(
    loaded.flowInstallPath,
    settings.form_schema,
  );

  validateFormSchemaVersion(schema, FORM_SCHEMA_VERSION);

  const prompt = `Awaiting form input for "${node.id}"`;
  const needsInputPath = path.join(dir, "needs-input.json");

  await atomicWriteJson(needsInputPath, {
    nodeId: node.id,
    kind: "form",
    schema,
    prompt,
    requestedAt: new Date().toISOString(),
  });

  const hitlRequestId = randomUUID();
  const roleRefs = settings.roles ?? [];
  const criticality = settings.criticality ?? null;

  const persistHitlRequestAndAssignment = async (tx: Db): Promise<void> => {
    await tx.insert(hitlRequests).values({
      id: hitlRequestId,
      runId: loaded.run.id,
      stepId: node.id,
      kind: "form",
      schema,
      prompt,
      criticality,
    });
    await createHitlAssignmentForRun({
      db: tx,
      runId: loaded.run.id,
      hitlRequestId,
      nodeId: node.id,
      actionKind: "form",
      roleRefs,
      title: prompt,
    });
    await emitWebhookEvent({
      db: tx,
      type: "hitl.requested",
      projectId: loaded.run.projectId,
      runId: loaded.run.id,
      data: { hitlRequestId, kind: "form", nodeId: node.id },
    });
  };

  try {
    if (
      typeof (ctx.db as { transaction?: unknown }).transaction === "function"
    ) {
      await (ctx.db as TransactionalDb).transaction(
        persistHitlRequestAndAssignment,
      );
    } else {
      await persistHitlRequestAndAssignment(ctx.db);
    }
  } catch (err) {
    await unlink(needsInputPath).catch((cleanupErr: unknown) => {
      log.error(
        {
          runId: loaded.run.id,
          nodeId: node.id,
          hitlRequestId,
          needsInputPath,
          err: asError(err).message,
          cleanupErr: asError(cleanupErr).message,
        },
        "failed to remove form needs-input.json after HITL persistence failure",
      );
    });
    throw err;
  }

  log.info(
    { runId: loaded.run.id, nodeId: node.id, hitlRequestId, roleRefs },
    "form intake HITL created — pausing NeedsInput",
  );

  return {
    ok: false,
    stdout: "",
    vars: {},
    durationMs: Date.now() - startedAt,
    needsInput: true,
  };
}

// Execute a graph node's action. Reuses the per-step runners by adapting the
// node into the shape they expect; human nodes go through the review HITL.
async function executeNodeAction(
  node: CompiledNode,
  loaded: LoadedRun,
  context: FlowContext,
  ctx: {
    runtimeRoot: string;
    worktreePath: string;
    sessionState: AcpSessionState;
    supervisorApi?: SupervisorApi;
    capabilityProfilePath?: string;
    adapterLaunch?: ScratchAdapterLaunch;
    mcpServers?: AgentMcpServer[];
    profileDigest?: string;
    nodeAttemptId: string;
    // 1-based ledger attempt number of THIS visit (ADR-072 gateAttempt source).
    nodeAttemptNumber: number;
    // M26 (ADR-063): this execution's attempt number — arms the per-attempt
    // MAISTER_OUTPUT_FILE transport for cli/check nodes with output.result.
    attempt: number;
    // M30 (ADR-081): resume the prior attempt's ACP session on this dispatch.
    resumeSessionId?: string;
    db: Db;
  },
): Promise<NodeResult> {
  if (node.source.kind !== "node") {
    throw new MaisterError(
      "CONFIG",
      `runGraph received a compiled-linear node (${node.id}); linear flows run on the linear runner`,
    );
  }

  const def = node.source.node;
  const common = {
    runtimeRoot: ctx.runtimeRoot,
    projectSlug: loaded.projectSlug,
    runId: loaded.run.id,
    stepId: node.id,
    nodeAttemptId: ctx.nodeAttemptId,
    worktreePath: ctx.worktreePath,
    context,
  };

  switch (def.type) {
    case "cli":
    case "check":
      return runCliStep(
        { id: node.id, type: "cli", command: def.action.command },
        // M26 (ADR-063): arm the MAISTER_OUTPUT_FILE transport only when the
        // node declares output.result — no transport provisioning otherwise.
        def.output?.result ? { ...common, attempt: ctx.attempt } : common,
      );
    case "ai_coding":
    case "judge":
      return runAgentStep(
        {
          id: node.id,
          type: "agent",
          mode: "new-session",
          prompt: def.action.prompt,
        },
        {
          ...common,
          // M34 (ADR-089): catalog-agent binding (ai_coding only).
          agentBinding:
            def.type === "ai_coding" &&
            (def.settings as { agent?: string } | undefined)?.agent
              ? { id: (def.settings as { agent: string }).agent }
              : undefined,
          // M30 (ADR-081): rework `resume` — the dispatch carries the prior
          // attempt's session handle (runner-agent falls back to a fresh
          // session, observably, when it is unresumable).
          resumeSessionId: ctx.resumeSessionId,
          executor: {
            id: loaded.executor.id,
            agent: loaded.executor.agent,
            model: loaded.executor.model,
            env: (loaded.executor.env ?? undefined) as
              | Record<string, string>
              | undefined,
            router: loaded.executor.router ?? undefined,
          },
          runner: runnerSupervisorInput({ snapshot: loaded.runner }),
          sessionState: ctx.sessionState,
          capabilityProfilePath: ctx.capabilityProfilePath,
          adapterLaunch: mergeRunnerAdapterLaunch(
            loaded.runner,
            ctx.adapterLaunch,
          ),
          mcpServers: ctx.mcpServers,
          profileDigest: ctx.profileDigest,
          // B1 (execution-policy permissions=auto_approve): fail-closed to
          // `ask`; threaded to the supervisor session for inline L3 auto-approve.
          autoApprovePermissions:
            permissionsFromSnapshot(loaded.run.executionPolicy ?? null) ===
            "auto_approve",
        },
        ctx.supervisorApi,
      );
    case "human":
      return runReviewHuman(node, loaded, `Review "${node.id}"`, {
        runtimeRoot: ctx.runtimeRoot,
        db: ctx.db,
        gateAttempt: ctx.nodeAttemptNumber,
      });
    case "form":
      return runFormCollect(node, loaded, def.settings, {
        runtimeRoot: ctx.runtimeRoot,
        db: ctx.db,
      });
    default:
      throw new MaisterError(
        "CONFIG",
        `unknown graph node type for node ${node.id}`,
      );
  }
}

// Forward-reachable node ids from `startNodeId` in the graph, excluding the
// start node itself. Used to compute which downstream nodes go stale on rework.
// M11b (ADR-030): exported so the takeover return route can stale
// `[reentryNode, ...downstreamOf(graph, reentryNode)]` — the re-entry node is a
// gate-bearing validation node and is added back explicitly because this helper
// excludes its start node by design.
export function downstreamOf(
  graph: ReturnType<typeof compileManifest>,
  startNodeId: string,
): string[] {
  const visited = new Set<string>();
  const queue: string[] = [startNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current)) continue;
    visited.add(current);

    const node = graph.nodes.get(current);

    if (!node) continue;

    for (const target of Object.values(node.transitions)) {
      if (target && target !== "done" && !visited.has(target)) {
        queue.push(target);
      }
    }
  }

  // Exclude the start node itself — it is the rework target, not downstream.
  visited.delete(startNodeId);

  return [...visited];
}

// Every `commentsVar` declared anywhere in the graph (on a node's `rework` or
// `finish.human`), seeded to "". A rework jump injects the reviewer's actual
// comments under this key (pendingInjectedVars), but a node that references
// `{{ <commentsVar> }}` can ALSO run on its initial (non-rework) visit — e.g. a
// flow whose entry node is also a rework target (aif-bugfix `fix`) — or after a
// rework with no comments. Strict templating throws on a missing top-level var,
// so without this seed such a prompt would crash the run. The seed makes a
// declared commentsVar always renderable (empty outside a rework); the
// per-rework injection overlays the real comments on the attempt it targets.
export function collectDeclaredCommentsVars(
  nodes: Iterable<CompiledNode>,
): Record<string, string> {
  const seeded: Record<string, string> = {};

  for (const node of nodes) {
    const commentsVar =
      node.rework?.commentsVar ?? node.finishHuman?.commentsVar;

    if (commentsVar) seeded[commentsVar] = "";
  }

  return seeded;
}

// ADR-072: a review_comments row in the structural shape the composer reads,
// plus the thread-assembly fields. Replies reuse the root shape with null
// anchor columns (DB CHECK).
type ReviewCommentRow = ComposeRootComment & {
  parentId: string | null;
  status: "open" | "resolved";
};

// ADR-072: load the run's OPEN review-comment threads (open roots + their
// replies) for the rework compose. Queries the schema directly instead of
// M30 (ADR-078): gate-chat transcript of this review node's DECIDING visit —
// the latest hitl row for (run, node) — in seq order, mapped for the rework
// composer. Direct table read for the same cycle reason as
// loadOpenReviewThreads below.
async function loadGateChatForCompose(
  runId: string,
  nodeId: string,
  db: Db,
): Promise<
  Array<{ role: "user" | "agent"; authorLabel: string; body: string }>
> {
  const hitlRows: Array<{ id: string }> = await db
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(and(eq(hitlRequests.runId, runId), eq(hitlRequests.stepId, nodeId)))
    .orderBy(desc(hitlRequests.createdAt))
    .limit(1);
  const hitlId = hitlRows[0]?.id;

  if (!hitlId) return [];

  const rows: Array<{
    role: "user" | "agent";
    authorLabel: string;
    body: string;
  }> = await db
    .select({
      role: gateChatMessages.role,
      authorLabel: gateChatMessages.authorLabel,
      body: gateChatMessages.body,
    })
    .from(gateChatMessages)
    .where(eq(gateChatMessages.hitlRequestId, hitlId))
    .orderBy(gateChatMessages.seq);

  return rows;
}

// lib/review-comments/service.ts `listThreads`: that module imports
// lib/services/hitl.ts (PENDING_HITL_RUN_STATUS), which imports
// lib/flows/runner.ts → this module — a cycle. The frozen ordering contract
// still has ONE home: the comparators in lib/review-comments/order.ts are
// shared with the service, and the composer re-sorts defensively.
async function loadOpenReviewThreads(
  runId: string,
  db: Db,
): Promise<ComposeThread[]> {
  const rows = (await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.runId, runId))) as ReviewCommentRow[];

  const repliesByRoot = new Map<string, ReviewCommentRow[]>();

  for (const row of rows) {
    if (row.parentId === null) continue;

    const bucket = repliesByRoot.get(row.parentId);

    if (bucket) {
      bucket.push(row);
    } else {
      repliesByRoot.set(row.parentId, [row]);
    }
  }

  return rows
    .filter((row) => row.parentId === null && row.status === "open")
    .sort(compareThreadRoots)
    .map((root) => ({
      root,
      replies: (repliesByRoot.get(root.id) ?? []).sort(compareThreadReplies),
    }));
}

// ADR-072 (D4) evidence snapshot: the composed rework payload as ONE
// artifact_instances row (kind human_note, producer runner, locator inline
// with additive {hitlRequestId, threadIds}), linked to the gate's
// node_attempt. Distinct from recordDefaultArtifacts' human_note row (locator
// hitl-response → the raw stored decision payload): this row freezes the
// composed TEXT the rework attempt actually received. Best-effort like the
// default-artifact writers — an evidence-write failure never fails the rework.
async function recordComposedCommentsEvidence(
  args: {
    runId: string;
    nodeId: string;
    nodeAttemptId: string;
    attempt: number;
    composed: string;
    threadIds: string[];
  },
  db: Db,
  logger: pino.Logger,
): Promise<void> {
  try {
    // The gate visit just consumed = the latest responded hitl row for this
    // node (mirrors the recordDefaultArtifacts hitl-response lookup).
    const hitlRows = (await db
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, args.runId),
          eq(hitlRequests.stepId, args.nodeId),
          isNotNull(hitlRequests.response),
        ),
      )
      .orderBy(desc(hitlRequests.createdAt))
      .limit(1)) as Array<{ id: string }>;
    const hitlRequestId = hitlRows[0]?.id;

    await recordArtifact(
      {
        // Reserved `adr071:` namespace — declared-output ids are
        // `run:<nodeAttemptId>:<artifactDefId>`, so a def literally named
        // `rework-comments` can never collide with this runner-internal row.
        // Frozen as `adr071` despite the ADR-072 renumber: it is an opaque
        // artifact-id segment, never parsed back to a number, so churning it
        // would only orphan rows already written under the old id.
        id: `run:${args.nodeAttemptId}:adr071:rework-comments`,
        runId: args.runId,
        nodeAttemptId: args.nodeAttemptId,
        nodeId: args.nodeId,
        attempt: args.attempt,
        kind: "human_note",
        producer: "runner",
        locator: {
          kind: "inline",
          text: args.composed,
          ...(hitlRequestId !== undefined ? { hitlRequestId } : {}),
          threadIds: args.threadIds,
        },
        validity: "current",
      },
      db,
    );
    logger.info(
      {
        runId: args.runId,
        nodeId: args.nodeId,
        nodeAttemptId: args.nodeAttemptId,
        hitlRequestId,
        threadCount: args.threadIds.length,
        composedLength: args.composed.length,
      },
      "rework comments evidence recorded",
    );
  } catch (err) {
    logger.warn(
      { runId: args.runId, nodeId: args.nodeId, err: asError(err).message },
      "rework comments evidence record failed (non-fatal)",
    );
  }
}

// M14 T4.1: resolve + materialize a capability profile for a capability-declaring
// ai_coding/judge node. Returns undefined when the node declares no
// capability-bearing settings — EXCEPT a claude node with a configured model,
// which still materializes a MODEL-ONLY profile so its run model reaches the
// adapter via settings.local.json (the only writer of that file; ADR-076).
// Writes NO secrets — mcp creds resolve from the host env via `${NAME}`
// placeholders the materializer emits (R-SECRET). Does NOT write the
// materialization ledger (that is T4.2).
async function materializeNodeCapabilities(
  node: CompiledNode,
  loaded: LoadedRun,
  worktreePath: string,
  nodeAttemptId: string,
  catalog: CapabilityCatalogRecord[],
  logger: pino.Logger,
): Promise<
  | {
      capabilityProfilePath: string;
      adapterLaunch: ScratchAdapterLaunch;
      mcpServers: AgentMcpServer[];
      plan: MaterializationPlan;
      // M29 (ADR-074, D-C2): the node's resolved restriction path sets,
      // threaded into GateRunContext for must_not_touch evaluation.
      restrictionPaths: RestrictionPathSet[];
    }
  | undefined
> {
  const agent = loaded.executor.agent;
  const settings = capabilityBearingSettings(node.nodeType, node.settings);
  const declares =
    !!settings &&
    !!(
      allNodeMcpRefs(settings.mcps).length ||
      settings.skills?.length ||
      settings.restrictions?.length ||
      settings.tools?.[agent]?.length ||
      settings.permissionMode
    );

  // claude pins its run model through settings.local.json, and this materialize
  // path is its ONLY writer — a capability-less claude node would otherwise
  // launch on the adapter-default model while the runner snapshot says otherwise
  // (ADR-076). So claude with a configured model still materializes a model-only
  // profile. codex pins supervisor-side via setSessionModel, so a settings-less
  // codex node needs no materialization.
  const pinModelOnly =
    !declares && agent === "claude" && !!loaded.executor.model;

  if (!declares && !pinModelOnly) return undefined;

  const profile = resolveCapabilityProfile({
    projectId: loaded.run.projectId,
    executorAgent: agent,
    // declares: undefined mcps → resolver default set; explicit list → that set
    // (required ∪ additional, T-C6). model-only pin → explicit [] so NO default
    // MCPs are pulled in (idsForKind treats undefined as "the default set").
    selectedMcpIds:
      declares && settings
        ? settings.mcps === undefined
          ? undefined
          : allNodeMcpRefs(settings.mcps)
        : [],
    selectedSkillIds: declares && settings ? settings.skills : [],
    selectedRestrictionIds: declares && settings ? settings.restrictions : [],
    planMode: "off",
    catalog,
  });

  const m = await materializeCapabilityProfile({
    runId: loaded.run.id,
    worktreePath,
    profile,
    nodeAttemptId,
    tools: declares && settings ? settings.tools?.[agent] : undefined,
    permissionMode: declares && settings ? settings.permissionMode : undefined,
    executor: {
      executorRefId: loaded.executor.executorRefId,
      agent,
      model: loaded.executor.model,
      router: loaded.executor.router ?? null,
    },
  });

  const plan: MaterializationPlan = {
    profileDigest: profile.profileDigest,
    resolvedRevisions: profile.supported.map((e) => ({
      refId: e.capabilityRefId,
      kind: e.kind,
      sha: e.revision ?? "",
    })),
    materializedFiles: m.materializedFiles,
    enforcedClasses: profile.enforced.map((e) => e.capabilityRefId),
    // `profile.instructed` includes downgraded (unsupported, silently-dropped)
    // caps; source from supported-but-not-enforced so the immutable plan never
    // lists a dropped capability as instructed (symmetric with enforcedClasses,
    // consistent with resolvedRevisions which uses profile.supported).
    instructedClasses: profile.supported
      .filter((e) => e.enforceability !== "enforced")
      .map((e) => e.capabilityRefId),
    refusedClasses: profile.refused.map((e) => e.capabilityRefId),
    cleanup: { status: "pending" },
  };

  // M27/T-C8b: stdio MCP servers spawn a local command — withhold them unless
  // the pinned flow revision is exec-trusted (T-B3). sse/http are remote (no
  // local exec) and always pass. This is the only spawn surface (mcpServers
  // reach the agent via createSession).
  const mcpServers = gateStdioMcpsByExecTrust(m.mcpServers, loaded.execTrust);
  const withheldStdio = m.mcpServers.length - mcpServers.length;

  if (withheldStdio > 0) {
    logger.warn(
      { nodeId: node.id, execTrust: loaded.execTrust, withheldStdio },
      "[runner.graph] stdio MCP servers withheld — flow revision not exec-trusted",
    );
  }

  logger.info(
    {
      nodeId: node.id,
      profileDigest: profile.profileDigest,
      matPath: m.profilePath,
    },
    "[runner.graph] node materialized",
  );

  return {
    capabilityProfilePath: m.profilePath,
    adapterLaunch: m.adapterLaunch,
    mcpServers,
    plan,
    // enforced + instructed together cover every selected (non-refused)
    // record, so a downgraded-but-selected restriction still gets sensed.
    restrictionPaths: restrictionPathSets([
      ...profile.enforced,
      ...profile.instructed,
    ]),
  };
}

// Graph runner (M11a). Walks the compiled FlowGraph writing the append-only
// node_attempts ledger, preserving the M8 resume-claim CAS, STEP_CHECKPOINTED
// pause, slash-session cleanup, and promoteNextPending. Gate execution
// (Phase 4) and decision validation + rework staleness (Phase 5) attach at the
// marked call sites.
export async function runGraph(
  loaded: LoadedRun,
  opts: RunFlowOptions = {},
): Promise<void> {
  const db: Db = opts.db ?? getDb();
  const runtimeRoot = opts.runtimeRoot ?? process.cwd();
  const runId = loaded.run.id;
  const log2 = log.child({ runId });

  // ADR-022/ADR-038: pull-project event-stream evidence at run boundaries (no
  // watcher). Best-effort — a projection failure must never break the runner.
  const safeProject = async () => {
    try {
      await projectRunEvents(runId, { db });
    } catch (err) {
      log2.warn(
        { runId, err: (err as Error).message },
        "projector sync-point failed",
      );
    }
  };

  log2.info({}, "runGraph start");

  if (loaded.run.status !== "Running" && loaded.run.status !== "NeedsInput") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} not in Running/NeedsInput state (got ${loaded.run.status})`,
    );
  }

  const graph = compileManifest(loaded.manifest);
  // M12 (T3.2): artifact enforcement is only active when the manifest declares
  // compat.engine_min >= 1.2.0 (the version that introduced typed artifacts).
  const artifactEnforcementActive = semverGte(
    loaded.manifest.compat?.engine_min ?? "0.0.0",
    "1.2.0",
  );
  const isNeedsInputResume =
    loaded.run.status === "NeedsInput" && loaded.run.currentStepId !== null;

  // M11b (ADR-030, 3.3 CRITICAL): a takeover RETURN flips the run to `Running`
  // (the AFTER-side marker) and parks `current_step_id` at the
  // `transitions.takeover` re-entry. The runner MUST resume that node — NEVER
  // `graph.entry`, which would re-execute the upstream agent and CLOBBER the
  // human's local edits (ADR-030 item 4 / AC-4). It is detected here, not by a
  // new run status (the closed enum), via the recorded-return ledger signal.
  // The status flip to Running is NOT made by this path (it is already Running);
  // the claim is guarded by a re-entry node_attempt append inside the FOR-UPDATE
  // transaction, so a concurrent dispatch (the return route's queueMicrotask +
  // the F3 startup sweep) loses the claim and no-ops.
  // M19 crash-recover (ADR-034): driveResume re-dispatched a crashed
  // `retry_safe` session-less node — the run is already `Running` with
  // current_step_id = the retained crash target. Without this mode runGraph
  // treats `Running` + existing attempts + no resume as already-owned and
  // no-ops (Codex round-3). The explicit `opts.crashResume` signal wins over the
  // takeover path. Claimed below by a single-winner CAS-clear of
  // resume_started_at.
  const isCrashResume =
    Boolean(opts.crashResume) &&
    !isNeedsInputResume &&
    loaded.run.status === "Running" &&
    loaded.run.currentStepId !== null;

  const isTakeoverResume =
    !isNeedsInputResume &&
    !isCrashResume &&
    loaded.run.status === "Running" &&
    loaded.run.currentStepId !== null &&
    (await hasPendingTakeoverResume(runId, loaded.run.currentStepId, db));

  const isResume = isNeedsInputResume || isTakeoverResume || isCrashResume;
  const resumeNodeId = isResume ? (loaded.run.currentStepId as string) : null;

  // For a takeover resume, the claim winner appends the fresh re-entry attempt
  // inside the claim transaction; the main loop reuses it (see resumingThisNode).
  let claimedTakeoverAttemptId: string | null = null;

  if (isNeedsInputResume) {
    // Atomic resume claim (ported from runFlow): only ONE concurrent runGraph
    // call may flip this NeedsInput row to Running and continue.
    const acquired = await db.transaction(async (tx: Db) => {
      const rows: RunRow[] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId));
      const fresh = rows[0];

      if (!fresh || fresh.status !== "NeedsInput") return false;
      if (fresh.currentStepId !== resumeNodeId) return false;

      await tx
        .update(runs)
        .set({ status: "Running" })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.status, "NeedsInput"),
            eq(runs.currentStepId, resumeNodeId),
          ),
        );

      return true;
    });

    if (!acquired) {
      log2.info(
        { currentStepId: resumeNodeId },
        "runGraph resume claim lost — another invocation owns this resume",
      );

      return;
    }

    loaded.run.status = "Running";
  } else if (isCrashResume) {
    // M19 crash-recover claim: the run is already Running (driveResume flipped
    // it). Single-winner guard = CAS-clear resume_started_at (set by recover /
    // scheduler-promote). The winner clears it and traverses from resumeNodeId
    // (re-running the crashed node as a fresh attempt); a concurrent loser sees
    // it already null → 0 rows → bails. No status change (already Running).
    const claimed = await db
      .update(runs)
      .set({ resumeStartedAt: null })
      .where(and(eq(runs.id, runId), isNotNull(runs.resumeStartedAt)))
      .returning({ id: runs.id });

    if (claimed.length === 0) {
      log2.info(
        { currentStepId: resumeNodeId },
        "runGraph crash-resume claim lost — another invocation owns this resume",
      );

      return;
    }

    log2.info(
      { currentStepId: resumeNodeId },
      "runGraph crash-resume claim acquired — re-dispatching retry_safe node",
    );
  } else if (isTakeoverResume) {
    // Takeover-return resume claim. Under a row lock, re-verify the recorded
    // return is still un-resumed (no fresh re-entry attempt), then append the
    // first re-entry attempt as the OBSERVABLE claim marker. A concurrent
    // loser's FOR UPDATE blocks until commit, re-checks
    // hasPendingTakeoverResume → now false (this attempt exists) → bails.
    const result = await db.transaction(async (tx: Db) => {
      const locked: RunRow[] = isPostgres()
        ? await tx.select().from(runs).where(eq(runs.id, runId)).for("update")
        : await tx.select().from(runs).where(eq(runs.id, runId));
      const fresh = locked[0];

      if (!fresh || fresh.status !== "Running") return null;
      if (fresh.currentStepId !== resumeNodeId) return null;

      const stillPending = await hasPendingTakeoverResume(
        runId,
        resumeNodeId as string,
        tx,
      );

      if (!stillPending) return null;

      const reentryNode = graph.nodes.get(resumeNodeId as string);

      if (!reentryNode) return null;

      const appended = await appendNodeAttempt({
        runId,
        nodeId: resumeNodeId as string,
        nodeType: reentryNode.nodeType,
        db: tx,
      });

      return appended.id;
    });

    if (!result) {
      log2.info(
        { currentStepId: resumeNodeId },
        "runGraph takeover-return resume claim lost — another invocation owns this resume",
      );

      return;
    }

    claimedTakeoverAttemptId = result;
    log2.info(
      { currentStepId: resumeNodeId, nodeAttemptId: result },
      "runGraph resuming returned takeover at transitions.takeover re-entry",
    );
  }

  // M11b (ADR-030): a `Running` run that is NOT a fresh launch (it already has
  // node_attempts) and was NOT claimed here as a resume is owned by ANOTHER
  // live traversal — a concurrent re-dispatch (the return route's queueMicrotask
  // + the F3 sweep both firing). It MUST NOT start a SECOND traversal from
  // graph.entry, which would re-run the upstream agent and clobber the human's
  // edits. Bail so the in-flight traversal remains the single writer. A genuine
  // fresh launch is `Running` with zero attempts and proceeds from entry.
  if (loaded.run.status === "Running" && !isResume) {
    const existing = await getNodeAttemptsForRun(runId, db);

    if (existing.length > 0) {
      log2.info(
        { attempts: existing.length },
        "runGraph: Running run already in flight (has attempts) — another traversal owns it; no-op",
      );

      return;
    }
  }

  if (isResume) {
    // Fail closed AFTER the claim (matches the linear runner ordering): only
    // the claim winner writes Crashed if the resume pointer is stale (node id
    // not in the pinned graph — bundle drift / hand-edited SHA dir).
    if (resumeNodeId !== null && !graph.nodes.has(resumeNodeId)) {
      log2.error(
        { currentStepId: resumeNodeId, flowRevision: loaded.run.flowRevision },
        "stale resume pointer — node id not in compiled graph; failing closed",
      );
      await db.transaction(async (tx: Db) => {
        const rows = await tx
          .update(runs)
          .set({ status: "Crashed", endedAt: new Date(), currentStepId: null })
          .where(eq(runs.id, runId))
          .returning({
            projectId: runs.projectId,
            taskId: runs.taskId,
            flowId: runs.flowId,
            runKind: runs.runKind,
          });

        if (rows.length > 0) {
          await emitWebhookEvent({
            db: tx,
            type: "run.crashed",
            projectId: rows[0].projectId,
            runId,
            data: { errorCode: "CONFIG" },
          });
          await emitDomainEvent({
            db: tx,
            kind: "run.crashed",
            projectId: rows[0].projectId,
            runId,
            taskId: rows[0].taskId,
            actor: { type: "system", id: null },
            payload: {
              runId,
              taskId: rows[0].taskId,
              flowId: rows[0].flowId,
              runKind: rows[0].runKind,
              reason: "CONFIG",
            },
          });
        }
      });

      throw new MaisterError(
        "CONFIG",
        `currentStepId="${resumeNodeId}" not found in graph for run ${runId}`,
      );
    }
  }

  const worktreePath = loaded.workspace.worktreePath;
  const sessionState: AcpSessionState = {
    currentSessionId: null,
    lastSeenMonotonicId: 0,
  };

  // M14 T4.1 / M27 T-B5 (ADR-069): load the live selectable catalog ONCE, then
  // PIN it to the launch-frozen `runs.resolved_capability_set` snapshot so a
  // mid-run edit/publish (a new same-id record at any scope, or a wholly new
  // capability) cannot change what THIS run materializes — in-flight
  // immutability. A run launched before the snapshot existed
  // (resolvedCapabilitySet null) keeps the prior live-catalog behavior.
  const catalog = pinCatalogToSnapshot(
    await loadSelectableCapabilities(loaded.run.projectId, db),
    loaded.run.resolvedCapabilitySet,
  );

  // On a rework jump, the reviewer's comments are injected into the rework
  // target's next-attempt context under the node's `commentsVar`; consumed by
  // the immediately-following node, then cleared.
  let pendingInjectedVars: Record<string, unknown> | undefined;

  // Seeded once per run so any `{{ <commentsVar> }}` reference is renderable on
  // a node's initial (non-rework) visit too; pendingInjectedVars overlays the
  // real comments on the rework attempt it targets.
  const declaredCommentsVars = collectDeclaredCommentsVars(
    graph.nodes.values(),
  );

  let needsInput = false;
  let checkpointed = false;
  let failed = false;
  let runErrorCode: MaisterErrorCode | null = null;

  let currentNodeId: string | null = resumeNodeId ?? graph.entry;
  // M30 (ADR-080): set when a failed attempt schedules an auto-retry — the
  // next iteration of the SAME node appends its attempt with auto_retry=true.
  let pendingAutoRetryNodeId: string | null = null;
  // M30 (ADR-081): set by the rework block — the next visit of the TARGET
  // node carries the resolved session policy (resume threads the prior
  // attempt's acp_session_id into the dispatch).
  let pendingSessionPolicy: { nodeId: string; policy: SessionPolicy } | null =
    null;

  // M30 (ADR-080): auto-retry decision for a failed ai_coding/cli attempt.
  // True → the caller `continue`s on the SAME node (a fresh attempt with a
  // fresh session — dispatch is hard-coded new-session). The workspace policy
  // applies via the ADR-079 engine BEFORE the retry; with no checkpoint
  // (degraded capture) it degrades to keep with a WARN. `attempts` bounds the
  // node's TOTAL ledger attempts — rework re-visits consume the same budget
  // by design (the bound is the observable ledger row count). An apply
  // failure abandons the retry (normal failure path), never corrupts.
  const scheduleAutoRetry = async (
    node: CompiledNode,
    code: MaisterErrorCode,
    state: { nodeAttemptNumber: number; attemptCheckpointRef: string | null },
  ): Promise<boolean> => {
    if (node.nodeType !== "ai_coding" && node.nodeType !== "cli") return false;
    if (node.source.kind !== "node") return false;

    const retryPolicy = (node.source.node as { retry_policy?: RetryPolicy })
      .retry_policy;

    if (!retryPolicy) return false;
    if (!(retryPolicy.on_errors as readonly string[]).includes(code)) {
      return false;
    }
    if (state.nodeAttemptNumber >= retryPolicy.attempts) {
      log2.warn(
        { nodeId: node.id, code, attempts: retryPolicy.attempts },
        "[retry] exhausted",
      );

      return false;
    }

    if (retryPolicy.workspace !== "keep") {
      if (!state.attemptCheckpointRef) {
        log2.warn(
          { nodeId: node.id, workspacePolicy: retryPolicy.workspace },
          "[retry] no checkpoint_ref — workspace policy degraded to keep",
        );
      } else {
        try {
          await applyWorkspacePolicy({
            policy: retryPolicy.workspace,
            worktreePath: loaded.workspace.worktreePath,
            checkpointRef: state.attemptCheckpointRef,
            rematerialize:
              retryPolicy.workspace === "fresh-attempt"
                ? () =>
                    materializeProjectBundlesIntoWorktree({
                      projectId: loaded.run.projectId,
                      worktreePath: loaded.workspace.worktreePath,
                      baseBranch: loaded.workspace.baseBranch ?? "main",
                      db,
                    })
                : undefined,
          });
        } catch (err) {
          log2.error(
            { nodeId: node.id, err: asError(err).message },
            "[retry] workspace apply failed — retry abandoned (normal failure)",
          );

          return false;
        }
      }
    }

    log2.info(
      {
        nodeId: node.id,
        code,
        attempt: `${state.nodeAttemptNumber}/${retryPolicy.attempts}`,
      },
      "[retry] scheduling auto-retry",
    );

    return true;
  };

  try {
    while (currentNodeId !== null) {
      const node = graph.nodes.get(currentNodeId);

      if (!node) {
        throw new MaisterError(
          "CONFIG",
          `graph traversal reached unknown node "${currentNodeId}"`,
        );
      }

      // Loop bounds derived from the persisted ledger so they hold across
      // multiple runGraph invocations (human-paced rework resumes as fresh
      // invocations that would reset any in-memory counter to 0).
      const attempts = await getNodeAttemptsForRun(runId, db);

      const totalExecutions = attempts.length;

      if (totalExecutions >= HARD_NODE_EXECUTION_CEILING) {
        throw new MaisterError(
          "CONFIG",
          `graph exceeded hard node-execution ceiling (${HARD_NODE_EXECUTION_CEILING}) for run ${runId}`,
        );
      }

      // Count persisted attempts for this node; the initial run is attempt 1,
      // so maxLoops reworks → maxLoops + 1 total attempts allowed.
      const nodeAttemptCount = attempts.filter(
        (a) => a.nodeId === node.id,
      ).length;

      // Reuse an existing NeedsInput attempt when resuming this exact node;
      // otherwise append a fresh attempt (append-only ledger).
      const lastForNode = [...attempts]
        .reverse()
        .find((a) => a.nodeId === node.id);

      const resumingThisNode =
        isResume &&
        node.id === resumeNodeId &&
        lastForNode?.status === "NeedsInput";

      // A reuse iteration re-enters the CURRENT visit: its attempt row already
      // exists (NeedsInput resume) or was appended by the takeover claim, so
      // the ledger count already includes this visit.
      const reusesCurrentAttempt =
        (claimedTakeoverAttemptId !== null && node.id === resumeNodeId) ||
        resumingThisNode;

      // rework.maxLoops bounds STARTING a fresh visit of a rework-capable node
      // (initial visit + maxLoops reworks = maxLoops + 1 total). The bound must
      // not fire on a reuse re-entry — there the count includes the current
      // visit, so a decision processed AT the final allowed visit (ADR-072:
      // e.g. approve at gateAttempt = maxLoops + 1) would be killed by its own
      // row. A rework that slips past the validate rule still dies here when
      // traversal returns to append visit maxLoops + 2 (the CONFIG backstop).
      if (
        node.rework &&
        !reusesCurrentAttempt &&
        nodeAttemptCount > node.rework.maxLoops
      ) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" exceeded rework.maxLoops (${node.rework.maxLoops}) for run ${runId}`,
        );
      }

      let nodeAttemptId: string;
      // 1-based ledger attempt number of THIS visit. On the reuse branches the
      // current attempt row already exists (it is `lastForNode`), so its
      // `attempt` IS the visit number; on the append branch the fresh row's
      // `attempt` is. ADR-072: the review-gate schema stamps this as
      // `gateAttempt` and the compose evidence row records it as `attempt`.
      let nodeAttemptNumber: number;
      // M30 (ADR-079/080): THIS attempt's checkpoint ref — the auto-retry
      // workspace policy applies against it. Null on resume reuse / capture
      // degrade (policy degrades to keep).
      let attemptCheckpointRef: string | null = null;
      // M30 (ADR-081): the resume handle for THIS dispatch (rework re-entry
      // with an effective `resume` policy and a live prior session id).
      let attemptResumeSessionId: string | undefined;

      // M11b (ADR-030): the takeover-resume claim already appended the re-entry
      // node's fresh attempt inside the claim transaction (the observable CAS
      // marker). Reuse it on the first loop iteration so the resume rerun does
      // not double-append; consume it once.
      if (claimedTakeoverAttemptId && node.id === resumeNodeId) {
        nodeAttemptId = claimedTakeoverAttemptId;
        claimedTakeoverAttemptId = null;
        nodeAttemptNumber = lastForNode?.attempt ?? nodeAttemptCount;
        log2.info(
          { nodeAttemptId, nodeId: node.id },
          "resuming returned takeover — reusing claimed re-entry attempt",
        );
      } else if (resumingThisNode && lastForNode) {
        nodeAttemptId = lastForNode.id;
        nodeAttemptNumber = lastForNode.attempt;
        log2.info(
          { nodeAttemptId, nodeId: node.id },
          "resuming existing node attempt from NeedsInput",
        );
      } else {
        // M30 (ADR-081): a rework re-entry consumes the resolved session
        // policy. The resume handle is the PRIOR attempt's acp_session_id —
        // resolved BEFORE the new row is appended.
        let appendSessionPolicy: SessionPolicy | undefined;

        if (pendingSessionPolicy && pendingSessionPolicy.nodeId === node.id) {
          appendSessionPolicy = pendingSessionPolicy.policy;
          pendingSessionPolicy = null;

          if (appendSessionPolicy === "resume") {
            const prior = await latestAttemptForNode(runId, node.id, db);

            attemptResumeSessionId = prior?.acpSessionId ?? undefined;
          }
        }

        const appended = await appendNodeAttempt({
          runId,
          nodeId: node.id,
          nodeType: node.nodeType,
          // M30 (ADR-080): the prior iteration scheduled this re-entry.
          autoRetry: pendingAutoRetryNodeId === node.id,
          sessionPolicy: appendSessionPolicy,
          db,
        });

        if (pendingAutoRetryNodeId === node.id) pendingAutoRetryNodeId = null;

        nodeAttemptId = appended.id;
        nodeAttemptNumber = appended.attempt;

        // Resume requested but no prior session handle exists → observable
        // immediate fallback (the dispatch goes out fresh).
        if (appendSessionPolicy === "resume" && !attemptResumeSessionId) {
          await setSessionFallback(nodeAttemptId, db);
        }

        // M30 (ADR-079): capture the pre-attempt workspace checkpoint for
        // ai_coding/cli attempts (new attempts only — a NeedsInput resume or
        // takeover re-entry is mid-attempt). Best-effort at THIS site only
        // (mirrors the M29 start-HEAD capture below: test fixtures run
        // non-git worktrees): a failed capture leaves checkpoint_ref NULL and
        // policies degrade to keep with a WARN at apply time.
        // applyWorkspacePolicy itself stays hard (CHECKPOINT).
        if (node.nodeType === "ai_coding" || node.nodeType === "cli") {
          try {
            const ck = await captureCheckpoint({
              worktreePath,
              namespace: "checkpoints",
              runId,
              id: nodeAttemptId,
            });

            await setCheckpointRef(nodeAttemptId, ck.ref, db);
            attemptCheckpointRef = ck.ref;
            log2.debug(
              { nodeId: node.id, nodeAttemptId, checkpointRef: ck.ref },
              "[checkpoint] pre-attempt checkpoint captured",
            );
          } catch (err) {
            log2.warn(
              { nodeId: node.id, nodeAttemptId, err: asError(err).message },
              "[checkpoint] capture failed — checkpoint_ref null, policies degrade to keep",
            );
          }
        }
      }

      // M29 (ADR-074, D-C3): capture HEAD at this node's FIRST attempt start
      // — write-if-absent, so attempt 2+/resume keep the true start. Best
      // effort: git unavailable at start → skip; the must_touch range falls
      // back to the cumulative branch range at gate time.
      try {
        const startHead = await resolveRefSha(worktreePath, "HEAD");

        await captureNodeStartHead(
          runDir(runtimeRoot, loaded.projectSlug, runId),
          node.id,
          startHead,
        );
      } catch {
        // no real git repo at node start — cumulative fallback at gate time
      }

      await db
        .update(runs)
        .set({ currentStepId: node.id })
        .where(eq(runs.id, runId));
      await markNodeRunning(nodeAttemptId, db);

      // M11c (ADR-032): per-node enforcement gate. For capability-bearing
      // (ai_coding/judge) nodes, record the resolved verdict snapshot on the
      // attempt and REFUSE the node before any agent session is spawned when a
      // strict intent cannot be honored by the resolved agent. The gate runs
      // BEFORE executeNodeAction → no createSession, so no permission deferred
      // can leak (3.6). The snapshot is written on BOTH paths (2.2).
      if (node.nodeType === "ai_coding" || node.nodeType === "judge") {
        const settings = capabilityBearingSettings(
          node.nodeType,
          node.settings,
        );
        const snapshot = evaluateNodeEnforcement(
          settings,
          loaded.executor.agent,
        );

        await setEnforcementSnapshot(nodeAttemptId, snapshot, db);

        try {
          assertNodeLaunchable(
            { id: node.id, nodeType: node.nodeType, settings },
            loaded.executor.agent,
          );
        } catch (err) {
          const e = isMaisterError(err)
            ? err
            : new MaisterError("CRASH", asError(err).message, {
                cause: asError(err),
              });

          log2.warn(
            { nodeId: node.id, code: e.code },
            "node refused by enforcement gate — Failed (no agent spawned)",
          );
          await markNodeFailed(nodeAttemptId, { errorCode: e.code }, db);
          failed = true;
          runErrorCode = e.code;
          break;
        }
      }

      // M12 (T3.4): pass current artifact rows to buildContext so templates
      // can reference {{ artifacts.<id>.kind/uri/validity/nodeId }}.
      const currentArtifacts = await getArtifactsForRun(runId, db);

      const context = buildContext({
        task: loaded.task,
        run: loaded.run,
        executor: loaded.executor,
        stepRuns: [],
        nodeAttempts: attempts,
        projectSlug: loaded.projectSlug,
        extraVars: { ...declaredCommentsVars, ...(pendingInjectedVars ?? {}) },
        artifacts: currentArtifacts,
      });

      // The injected rework comments are consumed by this node only.
      pendingInjectedVars = undefined;

      // M12 (T3.2): input artifact precondition check. Only when engine_min >= 1.2.0.
      // For each requires entry that is a bare artifact id (not a steps.* ref),
      // verify a current artifact row exists — if not, fail the node before action.
      if (artifactEnforcementActive && node.input?.requires) {
        for (const req of node.input.requires) {
          // Bare string refs that start with "steps." are not artifact ids — skip.
          const artifactId =
            typeof req === "string"
              ? req.match(/^steps\./)
                ? null
                : req
              : (req as { artifact: string }).artifact;

          if (!artifactId) continue;

          const existing = await getCurrentArtifact(runId, artifactId, db);

          if (!existing) {
            const msg = `required input artifact ${artifactId} missing or not current`;

            log2.warn({ nodeId: node.id, artifactId }, msg);
            await markNodeFailed(
              nodeAttemptId,
              {
                errorCode: "PRECONDITION",
                stdout: msg,
              },
              db,
            );
            failed = true;
            runErrorCode = "PRECONDITION";
            break;
          }
        }

        if (failed) break;
      }

      // M14 T4.1: for capability-declaring ai_coding/judge nodes, resolve +
      // materialize the per-node capability profile and hand its path +
      // adapterLaunch to executeNodeAction → createSession. Settings-less nodes
      // get undefined (no materialization). A resolve/materialize throw is
      // handled here like the enforcement gate above (markNodeFailed + break) so
      // the in-flight attempt never stays stale at Running on the outer catch.
      let materialized:
        | {
            capabilityProfilePath: string;
            adapterLaunch: ScratchAdapterLaunch;
            mcpServers: AgentMcpServer[];
            plan: MaterializationPlan;
            restrictionPaths: RestrictionPathSet[];
          }
        | undefined;

      if (node.nodeType === "ai_coding" || node.nodeType === "judge") {
        try {
          materialized = await materializeNodeCapabilities(
            node,
            loaded,
            worktreePath,
            nodeAttemptId,
            catalog,
            log2,
          );

          // T4.2: persist the run-start materialization plan (write-once).
          if (materialized) {
            await setMaterializationPlan(nodeAttemptId, materialized.plan, db);
          }
        } catch (err) {
          const e = isMaisterError(err)
            ? err
            : new MaisterError("CRASH", asError(err).message, {
                cause: asError(err),
              });

          log2.warn(
            { nodeId: node.id, code: e.code },
            "node capability materialization failed — Failed (no agent spawned)",
          );
          await markNodeFailed(nodeAttemptId, { errorCode: e.code }, db);
          failed = true;
          runErrorCode = e.code;
          break;
        }
      }

      let result: NodeResult;

      try {
        result = await executeNodeAction(node, loaded, context, {
          runtimeRoot,
          worktreePath,
          sessionState,
          supervisorApi: opts.supervisorApi,
          capabilityProfilePath: materialized?.capabilityProfilePath,
          adapterLaunch: materialized?.adapterLaunch,
          mcpServers: materialized?.mcpServers,
          profileDigest: materialized?.plan.profileDigest,
          nodeAttemptId,
          nodeAttemptNumber,
          attempt: nodeAttemptNumber,
          resumeSessionId: attemptResumeSessionId,
          db,
        });
      } catch (err) {
        const e = isMaisterError(err)
          ? err
          : new MaisterError("CRASH", asError(err).message, {
              cause: asError(err),
            });

        log2.error(
          { nodeId: node.id, code: e.code },
          "node action threw — Failed",
        );
        await markNodeFailed(nodeAttemptId, { errorCode: e.code }, db);
        if (
          await scheduleAutoRetry(node, e.code, {
            nodeAttemptNumber,
            attemptCheckpointRef,
          })
        ) {
          pendingAutoRetryNodeId = node.id;
          continue;
        }
        failed = true;
        runErrorCode = e.code;
        break;
      }

      if (result.needsInput) {
        // Ledger mark + status flip + run.needs_input outbox row are one
        // logical transition — they commit atomically or not at all.
        await db.transaction(async (tx: Db) => {
          await markNodeNeedsInput(nodeAttemptId, tx);
          const flipped = await tx
            .update(runs)
            .set({ status: "NeedsInput", currentStepId: node.id })
            .where(eq(runs.id, runId))
            .returning({ projectId: runs.projectId });

          if (flipped.length > 0) {
            await emitWebhookEvent({
              db: tx,
              type: "run.needs_input",
              projectId: flipped[0].projectId,
              runId,
              data: {
                reason: node.nodeType as "human" | "form",
                nodeId: node.id,
              },
            });
          }
        });
        if (result.acpSessionId && !loaded.run.acpSessionId) {
          await db
            .update(runs)
            .set({ acpSessionId: result.acpSessionId })
            .where(eq(runs.id, runId));
        }
        // M12 (T3.3): record defaults at pause so log/guards/diff exist for
        // the paused node even when it hasn't finished yet.
        await recordDefaultArtifacts(
          {
            runId,
            nodeAttemptId,
            nodeId: node.id,
            attempt: nodeAttemptCount + 1,
            projectSlug: loaded.projectSlug,
            workspace: loaded.workspace,
            runtimeRoot,
          },
          db,
        ).catch((err) => {
          log2.warn(
            { nodeId: node.id, err: (err as Error).message },
            "recordDefaultArtifacts (NeedsInput) failed (non-fatal)",
          );
        });
        needsInput = true;
        log2.info({ nodeId: node.id }, "node requested NeedsInput");
        break;
      }

      if (result.errorCode === "STEP_CHECKPOINTED") {
        await markNodeNeedsInput(nodeAttemptId, db);
        if (result.acpSessionId && !loaded.run.acpSessionId) {
          await db
            .update(runs)
            .set({ acpSessionId: result.acpSessionId })
            .where(eq(runs.id, runId));
        }
        checkpointed = true;
        log2.info({ nodeId: node.id }, "node paused by supervisor checkpoint");
        break;
      }

      // M30 (ADR-078 DD11): this node was resumed from a pause and is now
      // past it (success, failure, or rework — all leave the pause), so the
      // gate-chat L3 baseline refs for the run are stale — GC them. Bounded
      // at 1 per hitlRequest; best-effort (non-git fixtures / no refs).
      if (reusesCurrentAttempt) {
        try {
          await deleteRunCheckpointRefs(worktreePath, runId, [
            "chat-checkpoints",
          ]);
        } catch {
          log2.debug(
            { nodeId: node.id },
            "[checkpoint] chat baseline GC skipped (no git worktree)",
          );
        }
      }

      // M30 (ADR-081): the dispatch requested a resume but the session was
      // gone/unresumable — runner-agent fell back to a fresh session; record
      // it on the attempt row (observable, never silent).
      if (result.sessionFallback) {
        await setSessionFallback(nodeAttemptId, db);
      }

      if (!result.ok) {
        const code = (result.errorCode ?? "PRECONDITION") as MaisterErrorCode;

        await markNodeFailed(
          nodeAttemptId,
          { errorCode: code, exitCode: result.exitCode, stdout: result.stdout },
          db,
        );
        if (
          await scheduleAutoRetry(node, code, {
            nodeAttemptNumber,
            attemptCheckpointRef,
          })
        ) {
          pendingAutoRetryNodeId = node.id;
          continue;
        }
        failed = true;
        runErrorCode = code;
        log2.warn({ nodeId: node.id, errorCode: code }, "node failed");
        break;
      }

      // M26 P1 (ADR-063): structured-output validate seam — post-action,
      // pre-gates. A failure marks the attempt Failed (CONFIG) inside the
      // seam and aborts the finish exactly like the action-failure path
      // above; gates MUST NOT run after a seam failure. On success the seam
      // mutates result.vars in place — markNodeSucceeded below persists it.
      const structuredOutput = await validateNodeStructuredOutput({
        node,
        result,
        attempt: nodeAttemptCount + 1,
        nodeAttemptId,
        runId,
        projectSlug: loaded.projectSlug,
        runtimeRoot,
        flowInstallPath: loaded.flowInstallPath,
        db,
      });

      if (!structuredOutput.ok) {
        failed = true;
        runErrorCode = "CONFIG";
        log2.warn(
          { nodeId: node.id, reason: structuredOutput.reason },
          "structured output validation failed — node Failed",
        );
        break;
      }

      if (result.acpSessionId && !loaded.run.acpSessionId) {
        await db
          .update(runs)
          .set({ acpSessionId: result.acpSessionId })
          .where(eq(runs.id, runId));
        loaded.run.acpSessionId = result.acpSessionId;
      }

      // Run pre_finish.gates after the action succeeds, before the node
      // finishes (ADR-028). Each gate writes a gate_results row for THIS
      // attempt, so a re-run node (after rework) re-executes its gates — the
      // prior attempt's gates were flipped stale by markDownstreamStale. A
      // blocking gate failure aborts the finish: the node goes Failed -> run
      // Failed. Advisory gates record + continue. M11a gate results FEED but do
      // NOT gate promotion (M15/M18).
      if (node.gates.length > 0) {
        const gateOutcome = await runNodeGates(
          node,
          nodeAttemptId,
          loaded,
          context,
          {
            runtimeRoot,
            worktreePath,
            sessionState,
            supervisorApi: opts.supervisorApi,
            // M29 (ADR-074): the node's resolved restriction path sets for
            // must_not_touch — undefined for capability-less nodes.
            restrictionPaths: materialized?.restrictionPaths,
            db,
          },
        );

        if (!gateOutcome.ok) {
          await markNodeFailed(
            nodeAttemptId,
            { errorCode: "PRECONDITION" },
            db,
          );
          failed = true;
          runErrorCode = "PRECONDITION";
          log2.warn(
            { nodeId: node.id, gateId: gateOutcome.blockingFailedGateId },
            "blocking gate failed — node Failed",
          );
          break;
        }
      }

      // M12 (T3.2): output artifact recording — path/diff/commit_set kinds plus
      // the F1 catch-all inline producer for every OTHER declared kind
      // (lint_report/ai_judgment/etc.), sourced from the node's captured output.
      // Only active when engine_min >= 1.2.0. Runs AFTER action success AND
      // gates pass, BEFORE markNodeSucceeded.
      if (artifactEnforcementActive && node.output?.produces) {
        const nodeRunDir = runDir(runtimeRoot, loaded.projectSlug, runId);
        const currentAttempt = nodeAttemptCount + 1;

        for (const produces of node.output.produces) {
          if (produces.path !== undefined) {
            // File kind: verify a regular file exists under the run dir.
            // stat().isFile() (not access()) so an empty/dot path resolving to
            // the run directory is rejected, never recorded as a file artifact.
            const filePath = path.join(nodeRunDir, produces.path);
            let fileOk = false;

            try {
              fileOk = (await stat(filePath)).isFile();
            } catch {
              fileOk = false;
            }

            if (!fileOk) {
              const msg = `produced output file ${produces.path} not found for artifact ${produces.id}`;

              log2.warn({ nodeId: node.id, artifactId: produces.id }, msg);
              await markNodeFailed(
                nodeAttemptId,
                { errorCode: "PRECONDITION", stdout: msg },
                db,
              );
              failed = true;
              runErrorCode = "PRECONDITION";
              break;
            }

            const newId = `run:${nodeAttemptId}:${produces.id}`;

            await recordCurrentArtifact(
              {
                id: newId,
                runId,
                nodeAttemptId,
                nodeId: node.id,
                attempt: currentAttempt,
                artifactDefId: produces.id,
                kind: produces.kind,
                producer: "runner",
                locator: { kind: "file", path: produces.path },
                validity: "current",
                requiredFor: produces.requiredFor,
                visibility: produces.visibility ?? "internal",
                retention: produces.retention ?? "run",
              },
              db,
            );
          } else if (produces.kind === "diff") {
            // Diff kind: always record with git-range locator. The range
            // (merge-base vs main → immutable head SHA, EMPTY_TREE /
            // branch-name fallbacks) is shared with the M29 mutation sensor
            // via resolveDiffRange (ADR-074) — recording and gates must
            // compute byte-identical locators.
            const range = await resolveDiffRange({
              worktreePath: loaded.workspace.worktreePath,
              branch: loaded.workspace.branch,
            });

            if (range.headError !== undefined) {
              // no real git repo — keep the branch name
              log2.warn(
                {
                  nodeId: node.id,
                  branch: loaded.workspace.branch,
                  err: range.headError,
                },
                "resolveRefSha failed — storing mutable branch headRef",
              );
            }

            const baseCommit = range.base;
            const headRef = range.head;

            const newId = `run:${nodeAttemptId}:${produces.id}`;

            await recordCurrentArtifact(
              {
                id: newId,
                runId,
                nodeAttemptId,
                nodeId: node.id,
                attempt: currentAttempt,
                artifactDefId: produces.id,
                kind: "diff",
                producer: "runner",
                locator: {
                  kind: "git-range",
                  baseCommit,
                  headRef,
                },
                validity: "current",
                requiredFor: produces.requiredFor,
                visibility: produces.visibility ?? "internal",
                retention: produces.retention ?? "run",
              },
              db,
            );
          } else if (produces.kind === "commit_set") {
            // Commit set kind: always record with git-log locator. baseRef is
            // the merge-base against main (same resolution as the diff kind) so
            // the payload renders `git log baseRef..headRef` = the branch's own
            // commits. Storing the branch name as baseRef (as before) resolved
            // baseRef == headRef → an empty/wrong log. Branch-name fallback only
            // when git is unavailable (synthetic-flow test envs).
            let baseRef = loaded.workspace.branch;

            try {
              baseRef = await resolveBaseRef({
                worktreePath: loaded.workspace.worktreePath,
                branch: loaded.workspace.branch,
                mainBranch: "main",
              });
            } catch (err) {
              log2.warn(
                {
                  nodeId: node.id,
                  branch: loaded.workspace.branch,
                  err: (err as Error).message,
                },
                "resolveBaseRef failed — storing mutable branch baseRef for commit_set",
              );
            }

            // F3: store the immutable head SHA; branch-name fallback when git
            // is unavailable (synthetic-flow test envs).
            let headRef = loaded.workspace.branch;

            try {
              headRef = await resolveRefSha(
                loaded.workspace.worktreePath,
                loaded.workspace.branch,
              );
            } catch (err) {
              // no real git repo — keep the branch name
              log2.warn(
                {
                  nodeId: node.id,
                  branch: loaded.workspace.branch,
                  err: (err as Error).message,
                },
                "resolveRefSha failed — storing mutable branch headRef",
              );
            }

            const newId = `run:${nodeAttemptId}:${produces.id}`;

            await recordCurrentArtifact(
              {
                id: newId,
                runId,
                nodeAttemptId,
                nodeId: node.id,
                attempt: currentAttempt,
                artifactDefId: produces.id,
                kind: "commit_set",
                producer: "runner",
                locator: {
                  kind: "git-log",
                  baseRef,
                  headRef,
                },
                validity: "current",
                requiredFor: produces.requiredFor,
                visibility: produces.visibility ?? "internal",
                retention: produces.retention ?? "run",
              },
              db,
            );
          } else {
            // F1 catch-all: any other declared kind with no `path` and not
            // diff/commit_set (lint_report, ai_judgment, human_note,
            // test_report, …). Source the node's captured stdout. Prefer a
            // file locator to <nodeId>.log when that file exists (run-dir
            // confined → payload-serveable); otherwise an inline locator with
            // the stdout text. Record ONLY when there is real content — an
            // empty no-content output is left to the §3.6 backstop.
            const logPath = path.join(nodeRunDir, `${node.id}.log`);
            let logExists = false;

            try {
              await access(logPath);
              logExists = true;
            } catch {
              logExists = false;
            }

            const stdoutText = result.stdout ?? "";
            const hasContent = logExists || stdoutText.trim().length > 0;

            if (hasContent) {
              const newId = `run:${nodeAttemptId}:${produces.id}`;

              await recordCurrentArtifact(
                {
                  id: newId,
                  runId,
                  nodeAttemptId,
                  nodeId: node.id,
                  attempt: currentAttempt,
                  artifactDefId: produces.id,
                  kind: produces.kind,
                  producer: "runner",
                  locator: logExists
                    ? { kind: "file", path: `${node.id}.log` }
                    : {
                        kind: "inline",
                        // Cap inline payload to match the ledger's 1 MB stdout
                        // cap (runner-cli buffers up to 4 MB) — bound the row.
                        text: stdoutText.slice(0, 1024 * 1024),
                      },
                  validity: "current",
                  requiredFor: produces.requiredFor,
                  visibility: produces.visibility ?? "internal",
                  retention: produces.retention ?? "run",
                },
                db,
              );
            }
          }
        }

        if (failed) break;
      }

      // F1 §3.6 backstop: every declared output MUST have a current artifact by
      // node finish, else the node fails. Catches kinds the producers above
      // could not source (empty stdout, no <nodeId>.log) so a `requiredFor`
      // output is never silently skipped while the run reaches Review.
      if (artifactEnforcementActive && node.output?.produces) {
        let missingId: string | undefined;

        for (const produces of node.output.produces) {
          const current = await getCurrentArtifact(runId, produces.id, db);

          if (!current) {
            missingId = produces.id;
            break;
          }

          // A current row exists but from a PRIOR attempt — THIS attempt did not
          // re-produce the declared output (e.g. empty stdout on a rework run).
          // Leaving the prior row current would let stale evidence satisfy
          // review/merge readiness, so retire it (FSM current → failed) and fail
          // the node just as a never-produced output would.
          if (current.nodeAttemptId !== nodeAttemptId) {
            await failArtifact(current.id, db);
            missingId = produces.id;
            break;
          }
        }

        if (missingId) {
          const msg = `${missingId} declared but not produced`;

          await markNodeFailed(
            nodeAttemptId,
            { errorCode: "PRECONDITION", stdout: msg },
            db,
          );
          log2.warn({ nodeId: node.id, artifactId: missingId }, msg);
          failed = true;
          runErrorCode = "PRECONDITION";
          break;
        }
      }

      // M12 (T3.3): record default artifacts at node finish.
      await recordDefaultArtifacts(
        {
          runId,
          nodeAttemptId,
          nodeId: node.id,
          attempt: nodeAttemptCount + 1,
          projectSlug: loaded.projectSlug,
          workspace: loaded.workspace,
          runtimeRoot,
        },
        db,
      ).catch((err) => {
        log2.warn(
          { nodeId: node.id, err: (err as Error).message },
          "recordDefaultArtifacts failed (non-fatal)",
        );
      });

      // Determine the outcome that drives the transition. Action nodes finish
      // with "success"; a human review node finishes with its chosen decision.
      const outcome =
        node.source.kind === "node" && node.source.node.type === "human"
          ? (result.decision ?? "success")
          : "success";

      const target = node.transitions[outcome];
      const isRework =
        node.rework !== undefined &&
        target !== undefined &&
        node.rework.allowedTargets.includes(target);

      // M12 (F1): review-approval evidence gate. When a node finishes with a
      // non-rework outcome that completes the run (terminal transition → run
      // reaches Review), EVERY requiredFor:[review] def must be current and no
      // blocking artifact_required gate may be stale/failed. This enforces the
      // requiredFor:[review] contract even when the terminal node declares no
      // matching artifact_required gate — the gate alone only checks its own
      // inputArtifacts. The guard is keyed on the terminal transition, NOT on
      // node type: a review/approval node may be human OR agent/cli/check, and
      // all of them must satisfy the evidence contract before the run is Review.
      // Refusal mirrors a blocking gate failure: node Failed → run Failed; the
      // reviewer re-attempts after refreshing evidence.
      if (!isRework && resolveTransition(node, outcome) === null) {
        const readiness = await assertEvidenceReady(runId, "review", db);

        if (!readiness.ready) {
          const msg = `review refused: evidence not ready — ${readiness.reasons.join("; ")}`;

          await markNodeFailed(
            nodeAttemptId,
            { errorCode: "PRECONDITION", stdout: msg },
            db,
          );
          failed = true;
          runErrorCode = "PRECONDITION";
          log2.info(
            { runId, blockedBy: readiness.reasons },
            "review refusal (evidence not ready)",
          );
          break;
        }
      }

      // A.2 (axis A1): rework cap exhausted. The review wants rework again but
      // the author's maxLoops is spent — apply the run's execution-policy action
      // instead of looping. nodeAttemptNumber is the 1-based visit count of this
      // review node (maxLoops reworks = visits 1..maxLoops+1), so deciding rework
      // at visit > maxLoops is the overrun. Fail-closed default is `escalate`.
      // The loop-top rework.maxLoops backstop stays as defense-in-depth.
      if (
        isRework &&
        node.rework !== undefined &&
        nodeAttemptNumber > node.rework.maxLoops
      ) {
        const action = reworkExhaustionFromSnapshot(
          loaded.run.executionPolicy ?? null,
        );

        logExecPolicyAction({
          runId,
          kind: "rework_exhausted",
          detail: {
            nodeId: node.id,
            action,
            maxLoops: node.rework.maxLoops,
            attempt: nodeAttemptNumber,
          },
        });
        log2.info(
          { runId, nodeId: node.id, attempts: nodeAttemptNumber, action },
          "[rework.exhausted]",
        );

        if (action === "fail") {
          // Mark the overrun attempt Failed + fail the run (same in-loop
          // pattern as the evidence-readiness refusal above), rather than throw
          // and leave the attempt dangling NeedsInput on a Failed run.
          const msg = `node "${node.id}" exhausted rework.maxLoops (${node.rework.maxLoops}) for run ${runId} (execution-policy reworkExhaustion=fail)`;

          await markNodeFailed(
            nodeAttemptId,
            { errorCode: "CONFIG", stdout: msg },
            db,
          );
          failed = true;
          runErrorCode = "CONFIG";
          break;
        }

        if (action === "escalate") {
          // Reuse the review HITL substrate: re-pause for a human to make the
          // terminal call (approve or end the run). This visit's decision
          // artifact was consumed on read, so runReviewHuman creates a fresh
          // HITL request + assignment. The attempt row stays NeedsInput — a
          // re-decided rework re-exhausts here, so only a non-rework decision
          // moves the run forward.
          logExecPolicyAction({
            runId,
            kind: "escalated",
            detail: { nodeId: node.id, reason: "rework_exhausted" },
          });
          await runReviewHuman(
            node,
            loaded,
            `Rework limit (${node.rework.maxLoops}) reached for "${node.id}". A human must approve or end the run.`,
            { runtimeRoot, db, gateAttempt: nodeAttemptNumber },
          );
          await db.transaction(async (tx: Db) => {
            await markNodeNeedsInput(nodeAttemptId, tx);
            const flipped = await tx
              .update(runs)
              .set({ status: "NeedsInput", currentStepId: node.id })
              .where(eq(runs.id, runId))
              .returning({ projectId: runs.projectId });

            if (flipped.length > 0) {
              await emitWebhookEvent({
                db: tx,
                type: "run.needs_input",
                projectId: flipped[0].projectId,
                runId,
                data: { reason: "human", nodeId: node.id },
              });
            }
          });
          needsInput = true;
          log2.info(
            { nodeId: node.id },
            "rework exhausted → escalated to human (NeedsInput)",
          );
          break;
        }

        // ship_with_warning: ship past the loop on the node's forward
        // (non-rework) transition — its `success`/approve edge — recording the
        // warning on the attempt rather than jumping back or failing.
        const reworkTargets = node.rework.allowedTargets;
        const forwardOutcome =
          "success" in node.transitions
            ? "success"
            : Object.keys(node.transitions).find(
                (o) => !reworkTargets.includes(node.transitions[o]),
              );

        await markNodeSucceeded(
          nodeAttemptId,
          {
            stdout: result.stdout,
            vars: {
              ...(result.vars as Record<string, unknown>),
              execPolicyWarning: `shipped past rework cap (${node.rework.maxLoops}) without resolving the review`,
            },
            exitCode: result.exitCode,
            decision: forwardOutcome,
            acpSessionId: result.acpSessionId,
          },
          db,
        );
        if (materialized) {
          await cleanupNodeMaterialization({
            nodeAttemptId,
            runId: loaded.run.id,
            worktreePath,
            db,
          });
        }

        const next = forwardOutcome
          ? resolveTransition(node, forwardOutcome)
          : null;

        log2.info(
          {
            from: node.id,
            outcome: forwardOutcome ?? "(terminal)",
            to: next ?? "(terminal)",
            shipWithWarning: true,
          },
          "rework exhausted → ship_with_warning (forward transition)",
        );
        await safeProject();
        currentNodeId = next;
        continue;
      }

      if (isRework) {
        // Record the operator's chosen workspacePolicy from the artifact (Issue
        // 3 fix). M30 (ADR-079) executes it for real — closing the M11b
        // deferral — against the rework TARGET's pre-attempt checkpoint.
        const policyParse = workspacePolicySchema.safeParse(
          result.workspacePolicy,
        );
        const chosenPolicy: WorkspacePolicy = policyParse.success
          ? policyParse.data
          : "keep";

        if (chosenPolicy !== "keep") {
          const targetAttempt = target
            ? await latestAttemptForNode(runId, target, db)
            : null;
          const checkpointRef = targetAttempt?.checkpointRef ?? null;

          if (!checkpointRef) {
            // Pre-M30 rows / degraded capture: no checkpoint to apply
            // against — observable degrade, never a guess.
            log2.warn(
              {
                nodeId: node.id,
                reworkTarget: target,
                workspacePolicy: chosenPolicy,
              },
              "[checkpoint] no checkpoint_ref on rework target's latest attempt — policy degraded to keep",
            );
          } else {
            // X-ATOMIC: the git mutation runs BEFORE the ledger rework
            // writes. A crash after apply leaves the workspace rewound with
            // the review attempt still open — re-deciding the review re-runs
            // an idempotent apply against the same checkpoint.
            try {
              await applyWorkspacePolicy({
                policy: chosenPolicy,
                worktreePath,
                checkpointRef,
                rematerialize:
                  chosenPolicy === "fresh-attempt"
                    ? () =>
                        materializeProjectBundlesIntoWorktree({
                          projectId: loaded.run.projectId,
                          worktreePath,
                          // Pre-M30 workspaces may lack base_branch; the
                          // override only seeds AIF's base-branch hint.
                          baseBranch: loaded.workspace.baseBranch ?? "main",
                          db,
                        })
                    : undefined,
              });
              log2.info(
                {
                  nodeId: node.id,
                  reworkTarget: target,
                  workspacePolicy: chosenPolicy,
                  checkpointRef,
                },
                "[checkpoint] apply policy",
              );
            } catch (err) {
              const e = isMaisterError(err)
                ? err
                : new MaisterError("CHECKPOINT", asError(err).message, {
                    cause: asError(err),
                  });

              log2.error(
                { nodeId: node.id, code: e.code, err: e.message },
                "[checkpoint] git failed — workspacePolicy apply aborted, review attempt Failed",
              );
              await markNodeFailed(
                nodeAttemptId,
                { errorCode: e.code, stdout: e.message },
                db,
              );
              failed = true;
              runErrorCode = e.code;
              break;
            }
          }
        }

        await markNodeReworked(
          nodeAttemptId,
          { decision: outcome, workspacePolicy: chosenPolicy },
          db,
        );

        // M30 (ADR-081): resolve the rework session policy for the TARGET's
        // next attempt — rework-transition > target node > flow defaults >
        // engine default `resume`.
        if (target) {
          const targetDef =
            graph.nodes.get(target)?.source.kind === "node"
              ? (
                  graph.nodes.get(target)?.source as {
                    node: { session_policy?: SessionPolicy };
                  }
                ).node
              : undefined;
          const resolved = resolveSessionPolicy({
            reworkPolicy: node.rework?.session_policy,
            nodePolicy: targetDef?.session_policy,
            flowDefault: (
              loaded.manifest as {
                defaults?: { session_policy?: SessionPolicy };
              }
            ).defaults?.session_policy,
          });

          pendingSessionPolicy = { nodeId: target, policy: resolved.policy };
          log2.info(
            {
              nodeId: target,
              resolved: resolved.policy,
              source: resolved.source,
            },
            "[session-policy] resolved for rework re-entry",
          );
        }

        // Flip downstream nodes/gates stale so they rerun on the next attempt
        // (Issue 2 fix / AC-3 staleness). `target` is the rework jump destination;
        // everything forward-reachable from it (excluding itself) goes stale.
        if (target) {
          const downstream = downstreamOf(graph, target);

          if (downstream.length > 0) {
            await markDownstreamStale(runId, downstream, db);
            log2.info(
              { from: node.id, reworkTarget: target, downstream },
              "rework: downstream nodes staled",
            );
          }
        }

        // Inject the reviewer's comments into the rework target's next-attempt
        // context under the node's commentsVar (Phase 5.4). The reviewer submits
        // them in `comments` (or the commentsVar key) of the response. ADR-072:
        // the run's OPEN review-comment threads compose into the payload here,
        // at consumption — the respond route's stored response and the input
        // artifact stay pristine user-submitted values. This block runs AFTER
        // markDownstreamStale: this review node is itself downstream of the
        // rework target, so recording the evidence row earlier would let the
        // same rework's staling immediately flip it stale.
        const commentsVar =
          node.rework?.commentsVar ?? node.finishHuman?.commentsVar;

        if (commentsVar) {
          const vars = result.vars as Record<string, unknown>;
          const summary = vars[commentsVar] ?? vars.comments;
          const openThreads = await loadOpenReviewThreads(runId, db);
          // M30 (ADR-078): the deciding visit's gate-chat transcript folds
          // into the rework payload alongside the review comments.
          const chatMessages = await loadGateChatForCompose(runId, node.id, db);
          const hasComposeInput =
            openThreads.length > 0 || chatMessages.length > 0;

          // D3 zero-input guarantee: with no open threads AND no chat the raw
          // summary value passes through UNTOUCHED (byte-identical injection;
          // nothing injected when none was submitted) — pre-ADR-072 behavior.
          const composed = hasComposeInput
            ? composeReworkPayload(
                typeof summary === "string" ? summary : "",
                openThreads,
                chatMessages,
              )
            : typeof summary === "string"
              ? summary
              : undefined;
          const injected = hasComposeInput ? composed : summary;

          if (injected !== undefined) {
            pendingInjectedVars = { [commentsVar]: injected };
          }

          if (composed !== undefined) {
            await recordComposedCommentsEvidence(
              {
                runId,
                nodeId: node.id,
                nodeAttemptId,
                attempt: nodeAttemptNumber,
                composed,
                threadIds: openThreads.map((t) => t.root.id),
              },
              db,
              log2,
            );
          }

          log2.debug(
            {
              nodeId: node.id,
              commentsVar,
              openThreadCount: openThreads.length,
              composedLength: composed?.length ?? null,
              injected: injected !== undefined,
            },
            "rework comments composed",
          );
        }
      } else {
        await markNodeSucceeded(
          nodeAttemptId,
          {
            stdout: result.stdout,
            vars: result.vars,
            exitCode: result.exitCode,
            decision: outcome === "success" ? undefined : outcome,
            acpSessionId: result.acpSessionId,
          },
          db,
        );

        if (materialized) {
          await cleanupNodeMaterialization({
            nodeAttemptId,
            runId: loaded.run.id,
            worktreePath,
            db,
          });
        }
      }

      const next = resolveTransition(node, outcome);

      log2.info(
        { from: node.id, outcome, to: next ?? "(terminal)", rework: isRework },
        "node transition",
      );
      await safeProject();
      currentNodeId = next;
    }
  } catch (err) {
    const e = isMaisterError(err)
      ? err
      : new MaisterError("CRASH", asError(err).message, {
          cause: asError(err),
        });

    log2.error({ err: e.message, code: e.code }, "runGraph top-level error");
    failed = true;
    runErrorCode = e.code;
  }

  if (needsInput) {
    log2.info({}, "runGraph paused on NeedsInput");
    await cleanupSlashSession(
      sessionState,
      opts.supervisorApi?.deleteSession,
      log2,
    );
    await safeProject();

    return;
  }

  if (checkpointed) {
    log2.info({}, "runGraph paused on STEP_CHECKPOINTED — slot freed");
    await cleanupSlashSession(
      sessionState,
      opts.supervisorApi?.deleteSession,
      log2,
    );
    await safeProject();
    await promoteAfterExit(db, opts, log2);

    return;
  }

  const endedAt = new Date();

  // CAS on `status="Running"`: by this point the NeedsInput / checkpoint paths
  // returned early, so the run is still `Running` UNLESS a concurrent abandon /
  // takeover / reconcile-crash moved it off-status. Guard the terminal write so
  // that operator action wins instead of being clobbered back to Failed/Review
  // (#ledger-clobber / #split-brain).
  if (failed && runErrorCode === "CRASH") {
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Crashed", endedAt, currentStepId: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
        });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.crashed",
          projectId: rows[0].projectId,
          runId,
          data: { errorCode: runErrorCode },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.crashed",
          projectId: rows[0].projectId,
          runId,
          taskId: rows[0].taskId,
          actor: { type: "system", id: null },
          payload: {
            runId,
            taskId: rows[0].taskId,
            flowId: rows[0].flowId,
            runKind: rows[0].runKind,
            reason: runErrorCode ?? null,
          },
        });
      }
    });
    await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: "graph flow crashed",
    });
    log2.error({ runErrorCode }, "runGraph ended Crashed");
  } else if (failed) {
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Failed", endedAt, currentStepId: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({
          projectId: runs.projectId,
          taskId: runs.taskId,
          flowId: runs.flowId,
          runKind: runs.runKind,
        });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.failed",
          projectId: rows[0].projectId,
          runId,
          data: { errorCode: runErrorCode },
        });
        await emitDomainEvent({
          db: tx,
          kind: "run.failed",
          projectId: rows[0].projectId,
          runId,
          taskId: rows[0].taskId,
          actor: { type: "system", id: null },
          payload: {
            runId,
            taskId: rows[0].taskId,
            flowId: rows[0].flowId,
            runKind: rows[0].runKind,
            reason: runErrorCode ?? null,
          },
        });
      }
    });
    await systemCloseActiveAssignmentsForRun({
      db,
      runId,
      reason: "graph flow failed",
    });
    log2.warn({ runErrorCode }, "runGraph ended Failed");
  } else {
    await db.transaction(async (tx: Db) => {
      const rows = await tx
        .update(runs)
        .set({ status: "Review", endedAt, currentStepId: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
        .returning({ projectId: runs.projectId });

      if (rows.length > 0) {
        await emitWebhookEvent({
          db: tx,
          type: "run.review",
          projectId: rows[0].projectId,
          runId,
          data: { source: "runner" },
        });
      }
    });
    log2.info({}, "runGraph ended Review");
    await deliverRunIfAutoReady(runId, db);
  }

  await safeProject();
  await cleanupSlashSession(
    sessionState,
    opts.supervisorApi?.deleteSession,
    log2,
  );
  await promoteAfterExit(db, opts, log2);
}

async function promoteAfterExit(
  db: Db,
  opts: RunFlowOptions,
  log2: typeof log,
): Promise<void> {
  try {
    const nextOpts: RunFlowOptions = {
      db: opts.db,
      runtimeRoot: opts.runtimeRoot,
      supervisorApi: opts.supervisorApi,
    };
    // Lazy import to avoid a static cycle with runner.ts (runFlow imports
    // runGraph). promoteNextPending re-enters via runFlow, which dispatches.
    const { runFlow } = await import("../runner");

    await promoteNextPending({
      db,
      runFlow: (next) =>
        void runFlow(next, nextOpts).catch((e) => {
          log2.error(
            { err: (e as Error).message },
            "promoted runFlow failed (non-fatal)",
          );
        }),
    });
  } catch (err) {
    log2.error(
      { err: (err as Error).message },
      "promoteNextPending after runGraph exit failed (non-fatal)",
    );
  }
}
