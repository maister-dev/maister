import "server-only";

import type { GateDef } from "@/lib/config.schema";
import type { ArtifactKind, GateVerdict } from "@/lib/db/schema";
import type { AcpSessionState, FlowContext } from "../types";
import type { SupervisorApi } from "../runner-agent";
import type { CompiledNode } from "./compile";
import type { Db, LoadedRun } from "./runner-core";

import { eq } from "drizzle-orm";
import pino from "pino";

import { runAgentStep } from "../runner-agent";
import { runCliStep } from "../runner-cli";

import {
  failStaleArtifactsForDef,
  getCurrentArtifact,
  recordSkippedArtifact,
} from "./artifact-store";
import {
  createGateResult,
  markGateFailed,
  markGatePassed,
  markGateSkipped,
} from "./gate-store";

import * as schemaModule from "@/lib/db/schema";

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

// Extract every top-level brace-balanced `{...}` substring, string-aware (so
// braces inside string literals don't break balancing). Linear O(n) — no
// regex backtracking — and correctly captures objects with nested objects.
function balancedJsonObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return out;
}

// Tolerant structured-verdict parser for ai_judgment / skill_check output:
// find the LAST brace-balanced JSON object in the agent's text that carries a
// string `verdict` (handles nested objects). Returns null when none is found
// (caller records a `failed` gate with the raw prose as evidence — never a
// thrown domain code, ADR-028).
export function parseVerdict(output: string): GateVerdict | null {
  const candidates = balancedJsonObjects(output);

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]) as Record<string, unknown>;

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
      // not valid JSON — keep scanning earlier candidates
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
// skipped/pending — never silently passed. (ADR-028)
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
    // createGateResult persists this to gate_results.input_artifact_refs — the
    // key MUST be inputArtifactRefs (a variable spread bypasses TS excess-prop
    // checks, so a wrong key would be silently dropped).
    inputArtifactRefs: gate.inputArtifacts,
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
      // M11a scopes gate agents as isolated new-session verdict turns expected
      // to end_turn — they do NOT pause for HITL. If HITL-capable gate agents
      // land later, branch on res.errorCode (STEP_CHECKPOINTED / NeedsInput)
      // here instead of treating partial stdout as an unparseable verdict.
      // TODO(post-M11a): handle gate-agent HITL/checkpoint.
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
        // NOT a thrown MaisterError code (ADR-008 closed union / ADR-028).
        await markGateFailed(
          id,
          { verdict: "unparseable", reasons: [summarize(res.stdout)] },
          ctx.db,
        );

        return "failed";
      }

      if (isPassVerdict(verdict.verdict ?? "")) {
        await markGatePassed(id, verdict, ctx.db);

        return "passed";
      }

      await markGateFailed(id, verdict, ctx.db);

      return "failed";
    }

    case "artifact_required": {
      const { id } = await createGateResult({ ...base, status: "running" });
      const requiredIds = gate.inputArtifacts ?? [];
      const outputRef = gate.output?.id ?? undefined;

      // Verify every declared input artifact exists with validity='current'.
      let allPresent = true;
      const missingOrStale: string[] = [];

      for (const defId of requiredIds) {
        const artifact = await getCurrentArtifact(loaded.run.id, defId, ctx.db);

        if (!artifact) {
          allPresent = false;
          missingOrStale.push(defId);
        }
      }

      if (allPresent) {
        await markGatePassed(
          id,
          {
            verdict: "pass",
            reasons: [
              `all ${requiredIds.length} required artifact(s) present and current`,
            ],
          },
          ctx.db,
        );

        if (outputRef) {
          const { gateResults } = schemaModule as unknown as Record<
            string,
            any
          >;

          await ctx.db
            .update(gateResults)
            .set({ outputArtifactRef: outputRef })
            .where(eq(gateResults.id, id));
        }

        return "passed";
      }

      // FSM stale → failed: a BLOCKING gate's required input is unavailable —
      // mark any stale row of each missing def failed so the evidence graph
      // shows the unmet dependency explicitly. A later rework re-produces and
      // supersedes it, so recovery is unaffected.
      if (gate.mode === "blocking") {
        for (const defId of missingOrStale) {
          await failStaleArtifactsForDef(loaded.run.id, defId, ctx.db);
        }
      }

      await markGateFailed(
        id,
        {
          verdict: "fail",
          reasons: [
            `missing or stale artifact(s): ${missingOrStale.join(", ")}`,
          ],
        },
        ctx.db,
      );

      return "failed";
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

      // FSM (none) → skipped: an unknown/unsupported gate kind cannot be
      // evaluated. If it declares an output artifact, surface that output as
      // explicitly `skipped` rather than silently absent (forward-compat for
      // gate kinds a future engine introduces).
      const out = gate.output as
        | { id?: string; kind?: ArtifactKind }
        | undefined;

      if (out?.id) {
        await recordSkippedArtifact(
          {
            runId: loaded.run.id,
            nodeAttemptId,
            nodeId: node.id,
            artifactDefId: out.id,
            kind: out.kind ?? "generic_file",
          },
          ctx.db,
        );
      }

      return "skipped";
    }
  }
}
