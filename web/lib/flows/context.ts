import "server-only";

import type {
  ArtifactInstance as ArtifactInstanceRow,
  NodeAttempt as NodeAttemptRow,
  Run as RunRow,
  StepRun as StepRunRow,
  Task as TaskRow,
} from "@/lib/db/schema";
import type { FlowContext } from "./types";

import pino from "pino";

const log = pino({
  name: "flow-context",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_OUTPUT_TRUNCATION = 8 * 1024;

const DENY_PATTERNS: RegExp[] = [
  /TOKEN/i,
  /KEY/i,
  /SECRET/i,
  /PASSWORD/i,
  /AUTH/i,
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^DB_URL$/i,
  /^MAISTER_SUPERVISOR_URL$/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
];

const DEFAULT_ALLOW_PATTERNS: RegExp[] = [
  /^LANG$/,
  /^LC_/,
  /^TZ$/,
  /^PATH$/,
  /^HOME$/,
  /^USER$/,
  /^SHELL$/,
  /^TERM$/,
];

function isDenied(key: string): boolean {
  for (const p of DENY_PATTERNS) {
    if (p.test(key)) return true;
  }

  return false;
}

function isAllowed(key: string, extra: RegExp[]): boolean {
  for (const p of DEFAULT_ALLOW_PATTERNS) {
    if (p.test(key)) return true;
  }
  for (const p of extra) {
    if (p.test(key)) return true;
  }

  return false;
}

function buildEnv(
  source: Record<string, string | undefined>,
  envWhitelist: RegExp[],
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (isDenied(k)) continue;
    if (!isAllowed(k, envWhitelist)) continue;
    out[k] = v;
  }

  return out;
}

function truncateOutput(s: string | null, cap: number): string {
  if (s === null) return "";
  if (s.length <= cap) return s;

  return s.slice(0, cap);
}

function reduceStepRuns(
  stepRuns: StepRunRow[],
  cap: number,
): FlowContext["steps"] {
  const byStep = new Map<string, StepRunRow>();

  for (const sr of stepRuns) {
    const existing = byStep.get(sr.stepId);

    if (!existing || sr.attempt > existing.attempt) {
      byStep.set(sr.stepId, sr);
    }
  }

  const out: FlowContext["steps"] = {};

  for (const [stepId, sr] of byStep.entries()) {
    out[stepId] = {
      output: truncateOutput(sr.stdout, cap),
      vars: (sr.vars ?? {}) as Record<string, unknown>,
      exitCode: sr.exitCode ?? undefined,
    };
  }

  return out;
}

// M11a (ADR-027): templating highest-attempt-wins union. The step_runs map is
// the base (legacy rows); node_attempts (graph runner) overlay it and WIN per
// id (a graph run has no step_runs; a legacy run has no node_attempts — so they
// are disjoint in practice, but the union is correct for any mix).
function reduceLedger(
  stepRuns: StepRunRow[],
  nodeAttempts: NodeAttemptRow[],
  cap: number,
): FlowContext["steps"] {
  const out = reduceStepRuns(stepRuns, cap);

  const byNode = new Map<string, NodeAttemptRow>();

  for (const na of nodeAttempts) {
    const existing = byNode.get(na.nodeId);

    if (!existing || na.attempt > existing.attempt) byNode.set(na.nodeId, na);
  }

  for (const [nodeId, na] of byNode.entries()) {
    out[nodeId] = {
      output: truncateOutput(na.stdout, cap),
      vars: (na.vars ?? {}) as Record<string, unknown>,
      exitCode: na.exitCode ?? undefined,
    };
  }

  return out;
}

export type BuildContextArgs = {
  task: Pick<TaskRow, "id" | "title" | "prompt" | "attemptNumber">;
  run: Pick<RunRow, "id">;
  executor: {
    id: string;
    agent: "claude" | "codex";
    model: string;
    router?: "ccr" | null;
  };
  stepRuns: StepRunRow[];
  // M11a: graph runner passes node_attempts; they overlay step_runs in the
  // highest-attempt-wins union (ADR-027). Optional so linear callers are
  // unchanged.
  nodeAttempts?: NodeAttemptRow[];
  projectSlug: string;
  // M11a: extra top-level template vars injected for the rework target (e.g.
  // the review `commentsVar`). Reserved keys (task/run/executor/steps/env)
  // always win over these.
  extraVars?: Record<string, unknown>;
  envWhitelist?: RegExp[];
  envSource?: Record<string, string | undefined>;
  outputTruncationBytes?: number;
  // M12 (T3.4): artifact_instances rows for the run. Reduced to the artifacts
  // namespace keyed by artifactDefId, current-wins. Optional for backward compat.
  artifacts?: ArtifactInstanceRow[];
};

// M12 (T3.4): reduce artifact_instances rows to the artifacts namespace.
// Current-wins: when multiple rows exist for the same artifactDefId, the row
// with validity='current' replaces any prior row. If none is 'current' the
// latest row (by insertion order) wins — callers should pass only current rows.
function reduceArtifacts(
  rows: ArtifactInstanceRow[],
): FlowContext["artifacts"] {
  const out: FlowContext["artifacts"] = {};

  for (const row of rows) {
    if (!row.artifactDefId) continue;
    const id = row.artifactDefId;
    const existing = out[id];

    if (!existing || row.validity === "current") {
      out[id] = {
        kind: row.kind,
        uri: row.uri ?? undefined,
        validity: row.validity,
        nodeId: row.nodeId ?? undefined,
      };
    }
  }

  return out;
}

export function buildContext(args: BuildContextArgs): FlowContext {
  const cap = args.outputTruncationBytes ?? DEFAULT_OUTPUT_TRUNCATION;
  const envSource = args.envSource ?? process.env;
  const envWhitelist = args.envWhitelist ?? [];

  const env = buildEnv(envSource, envWhitelist);

  log.debug(
    {
      runId: args.run.id,
      envKeys: Object.keys(env),
      stepCount: args.stepRuns.length,
    },
    "buildContext",
  );

  return {
    // Extra vars first so the reserved keys below always win.
    ...(args.extraVars ?? {}),
    task: {
      id: args.task.id,
      title: args.task.title,
      prompt: args.task.prompt,
      attemptNumber: args.task.attemptNumber,
    },
    run: {
      id: args.run.id,
      attemptNumber: args.task.attemptNumber,
      projectSlug: args.projectSlug,
    },
    executor: {
      id: args.executor.id,
      agent: args.executor.agent,
      model: args.executor.model,
      router: args.executor.router ?? undefined,
    },
    steps: reduceLedger(args.stepRuns, args.nodeAttempts ?? [], cap),
    env,
    artifacts: reduceArtifacts(args.artifacts ?? []),
  };
}
