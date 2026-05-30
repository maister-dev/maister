import "server-only";

import type { GateDef } from "@/lib/config.schema";
import type { GateVerdict } from "@/lib/db/schema";
import type { AcpSessionState, FlowContext } from "../types";
import type { SupervisorApi } from "../runner-agent";
import type { CompiledNode } from "./compile";
import type { Db, LoadedRun } from "./runner-core";

import pino from "pino";

import { runAgentStep } from "../runner-agent";
import { runCliStep } from "../runner-cli";

import {
  createGateResult,
  markGateFailed,
  markGatePassed,
  markGateSkipped,
} from "./gate-store";

const log = pino({
  name: "flow-gates-exec",
  level: process.env.LOG_LEVEL ?? "info",
});

const VERDICT_EVIDENCE_CAP = 2000;

export type GateRunContext = {
  runtimeRoot: string;
  worktreePath: string;
  sessionState: AcpSessionState;
  supervisorApi?: SupervisorApi;
  db: Db;
};

export type GateRunResult = {
  // true if no blocking gate failed (the node may proceed to finish).
  ok: boolean;
  blockingFailedGateId?: string;
};

const PASS_VERDICTS = new Set([
  "pass",
  "passed",
  "approve",
  "approved",
  "ok",
  "success",
  "succeeded",
  "ready",
]);

function summarize(s: string | null | undefined): string {
  if (!s) return "";

  return s.length <= VERDICT_EVIDENCE_CAP
    ? s
    : s.slice(0, VERDICT_EVIDENCE_CAP);
}

// Tolerant structured-verdict parser for ai_judgment / skill_check output:
// find the last JSON object in the agent's text that carries a string
// `verdict`. Returns null when none is found (caller records a `failed`
// gate with the raw prose as evidence — never a thrown domain code, ADR-024).
export function parseVerdict(output: string): GateVerdict | null {
  const matches = output.match(/\{[\s\S]*?\}/g);

  if (!matches) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]) as Record<string, unknown>;

      if (obj && typeof obj === "object" && typeof obj.verdict === "string") {
        return {
          verdict: obj.verdict,
          confidence:
            typeof obj.confidence === "number" ? obj.confidence : undefined,
          reasons: Array.isArray(obj.reasons)
            ? obj.reasons.map((r) => String(r))
            : undefined,
          recommendedAction:
            typeof obj.recommendedAction === "string"
              ? obj.recommendedAction
              : undefined,
        };
      }
    } catch {
      // not JSON — keep scanning earlier candidates
    }
  }

  return null;
}

export function isPassVerdict(verdict: string): boolean {
  return PASS_VERDICTS.has(verdict.trim().toLowerCase());
}

// Run one node's `pre_finish.gates` in declared order, writing a gate_results
// row per gate. A `blocking` gate that fails aborts the node finish (caller
// fails the run); an `advisory` gate records its verdict and the node
// continues. Deferred kinds (artifact_required, external_check) are recorded as
// skipped/pending — never silently passed. (ADR-024)
export async function runNodeGates(
  node: CompiledNode,
  nodeAttemptId: string,
  loaded: LoadedRun,
  context: FlowContext,
  ctx: GateRunContext,
): Promise<GateRunResult> {
  let blockingFailedGateId: string | undefined;

  for (const gate of node.gates) {
    const status = await runOneGate(
      gate,
      node,
      nodeAttemptId,
      loaded,
      context,
      ctx,
    );

    log.info(
      {
        runId: loaded.run.id,
        nodeId: node.id,
        gateId: gate.id,
        kind: gate.kind,
        mode: gate.mode,
        status,
      },
      "gate executed",
    );

    if (
      gate.mode === "blocking" &&
      status === "failed" &&
      !blockingFailedGateId
    ) {
      blockingFailedGateId = gate.id;
      // Keep running the remaining gates so all verdicts are recorded for the
      // attempt, but the node will not finish (caller aborts).
    }
  }

  return { ok: blockingFailedGateId === undefined, blockingFailedGateId };
}

async function runOneGate(
  gate: GateDef,
  node: CompiledNode,
  nodeAttemptId: string,
  loaded: LoadedRun,
  context: FlowContext,
  ctx: GateRunContext,
): Promise<"passed" | "failed" | "skipped" | "pending"> {
  const base = {
    runId: loaded.run.id,
    nodeAttemptId,
    gateId: gate.id,
    kind: gate.kind,
    mode: gate.mode,
    inputArtifacts: gate.inputArtifacts,
    staleFrom: gate.staleFrom,
    db: ctx.db,
  };

  const common = {
    runtimeRoot: ctx.runtimeRoot,
    projectSlug: loaded.projectSlug,
    runId: loaded.run.id,
    stepId: gate.id,
    worktreePath: ctx.worktreePath,
    context,
  };

  switch (gate.kind) {
    case "command_check": {
      const { id } = await createGateResult({ ...base, status: "running" });

      if (!gate.command) {
        await markGateFailed(
          id,
          {
            verdict: "fail",
            reasons: ["command_check gate declares no command"],
          },
          ctx.db,
        );

        return "failed";
      }

      const res = await runCliStep(
        { id: gate.id, type: "cli", command: gate.command },
        common,
      );

      if (res.ok) {
        await markGatePassed(
          id,
          { verdict: "pass", reasons: [summarize(res.stdout)] },
          ctx.db,
        );

        return "passed";
      }

      await markGateFailed(
        id,
        {
          verdict: "fail",
          confidence: 1,
          reasons: [summarize(res.stdout)],
          recommendedAction: "fix and rerun",
        },
        ctx.db,
      );

      return "failed";
    }

    case "ai_judgment":
    case "skill_check": {
      const { id } = await createGateResult({ ...base, status: "running" });
      // skill_check runs a slash command (best-effort, no capability scoping —
      // TODO(M14)); ai_judgment runs a free prompt. Both default to a fresh
      // session for an isolated verdict (~$0.28 cache-creation cost, M0).
      const prompt =
        gate.kind === "skill_check"
          ? (gate.command ?? (gate.skill ? `/${gate.skill}` : ""))
          : (gate.prompt ?? "");

      if (!prompt) {
        await markGateFailed(
          id,
          {
            verdict: "fail",
            reasons: [`${gate.kind} gate declares no prompt/skill`],
          },
          ctx.db,
        );

        return "failed";
      }

      const res = await runAgentStep(
        { id: gate.id, type: "agent", mode: "new-session", prompt },
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

      const verdict = parseVerdict(res.stdout ?? "");

      if (!verdict) {
        // Unparseable verdict is a `failed` gate with raw prose as evidence —
        // NOT a thrown MaisterError code (ADR-008 closed union / ADR-024).
        await markGateFailed(
          id,
          { verdict: "unparseable", reasons: [summarize(res.stdout)] },
          ctx.db,
        );

        return "failed";
      }

      if (isPassVerdict(verdict.verdict)) {
        await markGatePassed(id, verdict, ctx.db);

        return "passed";
      }

      await markGateFailed(id, verdict, ctx.db);

      return "failed";
    }

    case "artifact_required": {
      // Needs the M12 typed-artifact graph to verify evidence exists/current.
      await createGateResult({ ...base, status: "skipped" });
      log.warn(
        { runId: loaded.run.id, gateId: gate.id },
        "artifact_required gate skipped — typed artifacts land in M12 (TODO(M12))",
      );

      return "skipped";
    }

    case "external_check": {
      // Needs the M16 operations API for CI/external systems to report. Left
      // pending (not terminal); M11a has no ingestion endpoint.
      await createGateResult({ ...base, status: "pending" });
      log.warn(
        { runId: loaded.run.id, gateId: gate.id },
        "external_check gate pending — ops ingestion API lands in M16 (TODO(M16))",
      );

      return "pending";
    }

    case "human_review": {
      // The human decision is captured at the node's finish.human review HITL
      // (Phase 5), not as a pre_finish gate. Record skipped so it is never
      // silently treated as passed.
      await markGateSkipped(
        (await createGateResult({ ...base, status: "running" })).id,
        {
          verdict: "deferred",
          reasons: ["human_review handled at node finish (Phase 5)"],
        },
        ctx.db,
      );
      log.warn(
        { runId: loaded.run.id, gateId: gate.id, nodeId: node.id },
        "human_review pre_finish gate deferred to node finish review (Phase 5)",
      );

      return "skipped";
    }

    default: {
      await createGateResult({ ...base, status: "skipped" });

      return "skipped";
    }
  }
}
