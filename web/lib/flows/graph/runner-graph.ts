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
import {
  appendNodeAttempt,
  getNodeAttemptsForRun,
  markNodeFailed,
  markNodeNeedsInput,
  markNodeReworked,
  markNodeRunning,
  markNodeSucceeded,
} from "./ledger";

import { atomicWriteJson } from "@/lib/atomic";
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
};

function runDir(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): string {
  return path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);
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

    return {
      ok: true,
      stdout: "",
      vars: existing,
      durationMs: Date.now() - startedAt,
      needsInput: false,
      decision,
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
  const isResume =
    loaded.run.status === "NeedsInput" && loaded.run.currentStepId !== null;
  const resumeNodeId = isResume ? (loaded.run.currentStepId as string) : null;

  // Fail closed if the resume node pointer is not in the (pinned) graph.
  if (isResume && resumeNodeId !== null && !graph.nodes.has(resumeNodeId)) {
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

  if (isResume) {
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
  }

  const worktreePath = loaded.workspace.worktreePath;
  const sessionState: AcpSessionState = {
    currentSessionId: null,
    lastSeenMonotonicId: 0,
  };

  let needsInput = false;
  let checkpointed = false;
  let failed = false;
  let runErrorCode: MaisterErrorCode | null = null;

  let currentNodeId: string | null = resumeNodeId ?? graph.entry;
  const visitsByNode = new Map<string, number>();
  let totalExecutions = 0;

  try {
    while (currentNodeId !== null) {
      const node = graph.nodes.get(currentNodeId);

      if (!node) {
        throw new MaisterError(
          "CONFIG",
          `graph traversal reached unknown node "${currentNodeId}"`,
        );
      }

      if (++totalExecutions > HARD_NODE_EXECUTION_CEILING) {
        throw new MaisterError(
          "CONFIG",
          `graph exceeded hard node-execution ceiling (${HARD_NODE_EXECUTION_CEILING}) for run ${runId}`,
        );
      }

      const visits = (visitsByNode.get(node.id) ?? 0) + 1;

      visitsByNode.set(node.id, visits);

      // rework.maxLoops bounds re-entries of a rework-capable node
      // (initial visit + maxLoops reworks).
      if (node.rework && visits > node.rework.maxLoops + 1) {
        throw new MaisterError(
          "CONFIG",
          `node "${node.id}" exceeded rework.maxLoops (${node.rework.maxLoops}) for run ${runId}`,
        );
      }

      // Reuse an existing NeedsInput attempt when resuming this exact node;
      // otherwise append a fresh attempt (append-only ledger).
      const attempts = await getNodeAttemptsForRun(runId, db);
      const lastForNode = [...attempts]
        .reverse()
        .find((a) => a.nodeId === node.id);

      let nodeAttemptId: string;
      const resumingThisNode =
        isResume &&
        node.id === resumeNodeId &&
        lastForNode?.status === "NeedsInput";

      if (resumingThisNode && lastForNode) {
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
      await markNodeRunning(nodeAttemptId, {}, db);

      const context = buildContext({
        task: loaded.task,
        run: loaded.run,
        executor: loaded.executor,
        stepRuns: [],
        nodeAttempts: attempts,
        projectSlug: loaded.projectSlug,
      });

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

      // TODO(M11a Phase 4): run node.gates (pre_finish) here — a blocking gate
      // failure aborts the finish (run Failed unless a rework target exists);
      // advisory records + continues. Phase 3 graph flows declare no gates.

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
        await markNodeReworked(
          nodeAttemptId,
          { decision: outcome, workspacePolicy: "keep" },
          db,
        );
        // TODO(M11a Phase 5): markDownstreamStale(runId, downstreamOf(target))
        // so re-run gates go stale, plus validate the decision against the
        // row's allow-list. Phase 3 has no gates yet; the pointer simply moves.
      } else {
        await markNodeSucceeded(
          nodeAttemptId,
          {
            stdout: result.stdout,
            vars: result.vars,
            exitCode: result.exitCode,
            decision: outcome === "success" ? undefined : outcome,
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
