import "server-only";

import type { Run as RunRow } from "@/lib/db/schema";
import type { AcpSessionState, FlowContext, StepResult } from "../types";
import type { SupervisorApi } from "../runner-agent";
import type { CompiledNode } from "./compile";
import type { Db, LoadedRun, RunFlowOptions } from "./runner-core";

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { buildContext } from "../context";
import { runAgentStep } from "../runner-agent";
import { runCliStep } from "../runner-cli";

import { cleanupSlashSession, asError } from "./runner-core";
import { compileManifest, resolveTransition } from "./compile";
import { runNodeGates } from "./gates-exec";
import {
  appendNodeAttempt,
  getNodeAttemptsForRun,
  hasPendingTakeoverResume,
  markDownstreamStale,
  markNodeFailed,
  markNodeNeedsInput,
  markNodeReworked,
  markNodeRunning,
  markNodeSucceeded,
} from "./ledger";

import { atomicWriteJson } from "@/lib/atomic";
import {
  workspacePolicySchema,
  type WorkspacePolicy,
} from "@/lib/config.schema";
import { promoteNextPending } from "@/lib/scheduler";
import {
  isMaisterError,
  MaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, hitlRequests } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "flow-runner-graph",
  level: process.env.LOG_LEVEL ?? "info",
});

// Hard backstop on total node executions per run — a defense beyond per-node
// rework.maxLoops so a misdeclared graph can never spin forever.
const HARD_NODE_EXECUTION_CEILING = 500;

type NodeResult = StepResult & {
  needsInput?: boolean;
  acpSessionId?: string;
  decision?: string;
  workspacePolicy?: string;
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

// Human review node: on resume read the operator's decision from the input
// artifact; on first visit create the review HITL (with the manifest-derived
// allow-list in `schema`) and pause. Full decision validation + rework
// staleness land in Phase 5; here the decision drives the pointer move.
async function runReviewHuman(
  node: CompiledNode,
  loaded: LoadedRun,
  prompt: string,
  ctx: { runtimeRoot: string; db: Db },
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
  };

  await atomicWriteJson(path.join(dir, "needs-input.json"), {
    nodeId: node.id,
    kind: "human_review",
    schema,
    prompt,
    requestedAt: new Date().toISOString(),
  });

  await ctx.db.insert(hitlRequests).values({
    id: randomUUID(),
    runId: loaded.run.id,
    stepId: node.id,
    kind: "human",
    schema,
    prompt,
  });

  log.info(
    { runId: loaded.run.id, nodeId: node.id },
    "review HITL created — pausing NeedsInput",
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
    worktreePath: ctx.worktreePath,
    context,
  };

  switch (def.type) {
    case "cli":
    case "check":
      return runCliStep(
        { id: node.id, type: "cli", command: def.action.command },
        common,
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
          executor: {
            id: loaded.executor.id,
            agent: loaded.executor.agent,
            model: loaded.executor.model,
            env: (loaded.executor.env ?? undefined) as
              | Record<string, string>
              | undefined,
            router: loaded.executor.router ?? undefined,
          },
          sessionState: ctx.sessionState,
        },
        ctx.supervisorApi,
      );
    case "human":
      return runReviewHuman(node, loaded, `Review "${node.id}"`, {
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

  log2.info({}, "runGraph start");

  if (loaded.run.status !== "Running" && loaded.run.status !== "NeedsInput") {
    throw new MaisterError(
      "PRECONDITION",
      `run ${runId} not in Running/NeedsInput state (got ${loaded.run.status})`,
    );
  }

  const graph = compileManifest(loaded.manifest);
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
  const isTakeoverResume =
    !isNeedsInputResume &&
    loaded.run.status === "Running" &&
    loaded.run.currentStepId !== null &&
    (await hasPendingTakeoverResume(runId, loaded.run.currentStepId, db));

  const isResume = isNeedsInputResume || isTakeoverResume;
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
      await db
        .update(runs)
        .set({ status: "Crashed", endedAt: new Date(), currentStepId: null })
        .where(eq(runs.id, runId));

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

  // On a rework jump, the reviewer's comments are injected into the rework
  // target's next-attempt context under the node's `commentsVar`; consumed by
  // the immediately-following node, then cleared.
  let pendingInjectedVars: Record<string, unknown> | undefined;

  let needsInput = false;
  let checkpointed = false;
  let failed = false;
  let runErrorCode: MaisterErrorCode | null = null;

  let currentNodeId: string | null = resumeNodeId ?? graph.entry;

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

      // rework.maxLoops bounds re-entries of a rework-capable node
      // (initial visit + maxLoops reworks).
      if (node.rework && nodeAttemptCount > node.rework.maxLoops) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" exceeded rework.maxLoops (${node.rework.maxLoops}) for run ${runId}`,
        );
      }

      // Reuse an existing NeedsInput attempt when resuming this exact node;
      // otherwise append a fresh attempt (append-only ledger).
      const lastForNode = [...attempts]
        .reverse()
        .find((a) => a.nodeId === node.id);

      let nodeAttemptId: string;
      const resumingThisNode =
        isResume &&
        node.id === resumeNodeId &&
        lastForNode?.status === "NeedsInput";

      // M11b (ADR-030): the takeover-resume claim already appended the re-entry
      // node's fresh attempt inside the claim transaction (the observable CAS
      // marker). Reuse it on the first loop iteration so the resume rerun does
      // not double-append; consume it once.
      if (claimedTakeoverAttemptId && node.id === resumeNodeId) {
        nodeAttemptId = claimedTakeoverAttemptId;
        claimedTakeoverAttemptId = null;
        log2.info(
          { nodeAttemptId, nodeId: node.id },
          "resuming returned takeover — reusing claimed re-entry attempt",
        );
      } else if (resumingThisNode && lastForNode) {
        nodeAttemptId = lastForNode.id;
        log2.info(
          { nodeAttemptId, nodeId: node.id },
          "resuming existing node attempt from NeedsInput",
        );
      } else {
        const appended = await appendNodeAttempt({
          runId,
          nodeId: node.id,
          nodeType: node.nodeType,
          db,
        });

        nodeAttemptId = appended.id;
      }

      await db
        .update(runs)
        .set({ currentStepId: node.id })
        .where(eq(runs.id, runId));
      await markNodeRunning(nodeAttemptId, db);

      const context = buildContext({
        task: loaded.task,
        run: loaded.run,
        executor: loaded.executor,
        stepRuns: [],
        nodeAttempts: attempts,
        projectSlug: loaded.projectSlug,
        extraVars: pendingInjectedVars,
      });

      // The injected rework comments are consumed by this node only.
      pendingInjectedVars = undefined;

      let result: NodeResult;

      try {
        result = await executeNodeAction(node, loaded, context, {
          runtimeRoot,
          worktreePath,
          sessionState,
          supervisorApi: opts.supervisorApi,
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
        failed = true;
        runErrorCode = e.code;
        break;
      }

      if (result.needsInput) {
        await markNodeNeedsInput(nodeAttemptId, db);
        await db
          .update(runs)
          .set({ status: "NeedsInput", currentStepId: node.id })
          .where(eq(runs.id, runId));
        if (result.acpSessionId && !loaded.run.acpSessionId) {
          await db
            .update(runs)
            .set({ acpSessionId: result.acpSessionId })
            .where(eq(runs.id, runId));
        }
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

      if (!result.ok) {
        const code = (result.errorCode ?? "PRECONDITION") as MaisterErrorCode;

        await markNodeFailed(
          nodeAttemptId,
          { errorCode: code, exitCode: result.exitCode, stdout: result.stdout },
          db,
        );
        failed = true;
        runErrorCode = code;
        log2.warn({ nodeId: node.id, errorCode: code }, "node failed");
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

      if (isRework) {
        // Record the operator's chosen workspacePolicy from the artifact (Issue
        // 3 fix). Only `keep` executes in M11a; others are recorded + warned.
        const policyParse = workspacePolicySchema.safeParse(
          result.workspacePolicy,
        );
        const chosenPolicy: WorkspacePolicy = policyParse.success
          ? policyParse.data
          : "keep";

        if (chosenPolicy !== "keep") {
          log2.warn(
            { nodeId: node.id, workspacePolicy: chosenPolicy },
            "workspacePolicy other than 'keep' recorded but execution deferred to M11b — TODO(M11b)",
          );
        }

        await markNodeReworked(
          nodeAttemptId,
          { decision: outcome, workspacePolicy: chosenPolicy },
          db,
        );

        // Inject the reviewer's comments into the rework target's next-attempt
        // context under the node's commentsVar (Phase 5.4). The reviewer submits
        // them in `comments` (or the commentsVar key) of the response.
        const commentsVar =
          node.rework?.commentsVar ?? node.finishHuman?.commentsVar;

        if (commentsVar) {
          const vars = result.vars as Record<string, unknown>;
          const comments = vars[commentsVar] ?? vars.comments;

          if (comments !== undefined) {
            pendingInjectedVars = { [commentsVar]: comments };
          }
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
      }

      const next = resolveTransition(node, outcome);

      log2.info(
        { from: node.id, outcome, to: next ?? "(terminal)", rework: isRework },
        "node transition",
      );
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

    return;
  }

  if (checkpointed) {
    log2.info({}, "runGraph paused on STEP_CHECKPOINTED — slot freed");
    await cleanupSlashSession(
      sessionState,
      opts.supervisorApi?.deleteSession,
      log2,
    );
    await promoteAfterExit(db, opts, log2);

    return;
  }

  const endedAt = new Date();

  if (failed && runErrorCode === "CRASH") {
    await db
      .update(runs)
      .set({ status: "Crashed", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.error({ runErrorCode }, "runGraph ended Crashed");
  } else if (failed) {
    await db
      .update(runs)
      .set({ status: "Failed", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.warn({ runErrorCode }, "runGraph ended Failed");
  } else {
    await db
      .update(runs)
      .set({ status: "Review", endedAt, currentStepId: null })
      .where(eq(runs.id, runId));
    log2.info({}, "runGraph ended Review");
  }

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
      runFlow: (next) => void runFlow(next, nextOpts),
    });
  } catch (err) {
    log2.error(
      { err: (err as Error).message },
      "promoteNextPending after runGraph exit failed (non-fatal)",
    );
  }
}
