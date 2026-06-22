import "server-only";

import { join } from "node:path";

import pino from "pino";

import type { GateResult, NodeAttempt, StepRun } from "@/lib/db/schema";
import type { Db } from "./runner-core";

import { atomicWriteJson } from "@/lib/atomic";
import { ensureWorktreeGitExclude } from "@/lib/capabilities/materialize";
import { DEFAULT_OUTPUT_TRUNCATION, reduceLedger } from "../context";

import { getGateResultsForRun } from "./gate-store";
import { getNodeAttemptsForRun } from "./ledger";

const log = pino({
  name: "run-context",
  level: process.env.LOG_LEVEL ?? "info",
});

// P7 (M26/ADR-103): the session-independent run-context blackboard. A PURE
// projection of node_attempts + gate_results + task.prompt — a fresh, cleared, or
// resumed session reconstructs identical state from it. Hardcoded "all" shape per
// the M26 spec (intent + every node's summary/vars + every gate's status/verdict
// + a flat promoted union).
export type RunContextFile = {
  intent: string;
  nodes: Record<string, { summary: string; vars: Record<string, unknown> }>;
  gates: Record<string, { status: string; verdict?: unknown }>;
  promoted: Record<string, unknown>;
};

export type BuildRunContextArgs = {
  taskPrompt: string;
  nodeAttempts: NodeAttempt[];
  gateResults: GateResult[];
  stepRuns?: StepRun[];
  outputTruncationBytes?: number;
};

// Build the run-context projection. PURE — no I/O, never reads `context.env`, so
// no env secret can enter the file (secret-safety). Idempotent: the same ledger
// yields byte-identical output (including the `promoted` collision winners, which
// are last-wins by `reduceLedger` node-iteration order).
export function buildRunContext(args: BuildRunContextArgs): RunContextFile {
  const cap = args.outputTruncationBytes ?? DEFAULT_OUTPUT_TRUNCATION;
  const ledger = reduceLedger(args.stepRuns ?? [], args.nodeAttempts, cap);

  const nodes: RunContextFile["nodes"] = {};
  const promoted: Record<string, unknown> = {};

  for (const [id, entry] of Object.entries(ledger)) {
    nodes[id] = { summary: entry.output, vars: entry.vars };
    // promoted = flat union of every node's vars; last-wins by node-iteration
    // order (reduceLedger returns highest-attempt rows in execution order).
    for (const [k, v] of Object.entries(entry.vars)) promoted[k] = v;
  }

  const gates: RunContextFile["gates"] = {};

  // gate_results arrive ordered by createdAt asc → the last row per gateId is the
  // latest. `status` is always present (the source of truth for
  // command_check/human_review whose verdict is null); `verdict` only when set.
  for (const g of args.gateResults) {
    gates[g.gateId] =
      g.verdict != null
        ? { status: g.status, verdict: g.verdict }
        : { status: g.status };
  }

  return { intent: args.taskPrompt, nodes, gates, promoted };
}

export function runContextPath(worktreePath: string): string {
  return join(worktreePath, ".maister", "run.json");
}

// Write (or rewrite) <worktree>/.maister/run.json. Best-effort — correctness never
// depends on it (ledger + worktree are the source of truth), so the caller wraps
// this so a write failure never fails the run. The `.maister/` git-exclude is the
// caller's run-start responsibility (ensureWorktreeGitExclude), NOT re-run here.
export async function writeRunContext(args: {
  runId: string;
  worktreePath: string;
  taskPrompt: string;
  db: Db;
}): Promise<void> {
  const { runId, worktreePath, taskPrompt, db } = args;

  const [nodeAttempts, gateResults] = await Promise.all([
    getNodeAttemptsForRun(runId, db),
    getGateResultsForRun(runId, db),
  ]);

  const ctx = buildRunContext({ taskPrompt, nodeAttempts, gateResults });
  const path = runContextPath(worktreePath);

  await atomicWriteJson(path, ctx);
  log.debug(
    {
      runId,
      path,
      nodes: Object.keys(ctx.nodes).length,
      gates: Object.keys(ctx.gates).length,
    },
    "[run-context] wrote run.json",
  );
}

// Idempotent run-start ensure of the `.maister/` git-exclude, BEFORE the first
// run.json write (Q3 ordering invariant). Best-effort — a non-git worktree
// degrades silently (the exclude is informational; run.json still writes).
export async function ensureRunContextExcluded(
  worktreePath: string,
): Promise<void> {
  await ensureWorktreeGitExclude(worktreePath);
}
