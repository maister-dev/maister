import "server-only";

import type { GateDef } from "@/lib/config.schema";
import type { ArtifactKind, GateVerdict } from "@/lib/db/schema";
import type { AcpSessionState, FlowContext } from "../types";
import type { SupervisorApi } from "../runner-agent";
import type { CompiledNode } from "./compile";
import type { Db, LoadedRun } from "./runner-core";
import type { RestrictionPathSet } from "./mutation-check";

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";

import { runAgentStep } from "../runner-agent";
import { runCliStep } from "../runner-cli";

import {
  failStaleArtifactsForDef,
  getCurrentArtifact,
  recordCurrentArtifact,
  recordSkippedArtifact,
} from "./artifact-store";
import {
  createGateResult,
  markGateFailed,
  markGatePassed,
  markGateSkipped,
} from "./gate-store";
import {
  evaluateMutationAssertions,
  readNodeStartHead,
  resolveDiffRange,
  runDirPath,
  touchedPaths,
} from "./mutation-check";
import {
  isEffectivelyBlockingGate,
  isPolicySkippedGate,
} from "./readiness-core";
import { extractBalancedJsonObjects } from "./json-extract";

import * as schemaModule from "@/lib/db/schema";
import { logExecPolicyAction } from "@/lib/runs/exec-policy-audit";
import {
  checksFromSnapshot,
  type CheckStrictness,
} from "@/lib/runs/execution-policy";

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
  // M29 (ADR-074, D-C2): the node's resolved restriction path sets for
  // must_not_touch; undefined when the node declares no restrictions.
  restrictionPaths?: RestrictionPathSet[];
  db: Db;
};

export type GateRunResult = {
  // true if no blocking gate failed (the node may proceed to finish).
  ok: boolean;
  blockingFailedGateId?: string;
  // M38 (ADR-103): the calibrated verdict surfaced by the verdict-producing gate
  // (ai_judgment/skill_check). Present only for a node declaring
  // `decide:{from:verdict}`, where the engine treats that gate as routing-input
  // (it does NOT hard-fail the node) and feeds this verdict to the decide table.
  verdict?: GateVerdict;
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
// find the LAST brace-balanced JSON object in the agent's text that carries a
// string `verdict` (handles nested objects). Returns null when none is found
// (caller records a `failed` gate with the raw prose as evidence — never a
// thrown domain code, ADR-028).
export function parseVerdict(output: string): GateVerdict | null {
  const candidates = extractBalancedJsonObjects(output);

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

// Applies the effective calibration policy to a parsed PASS verdict.
// Only call when isPassVerdict(parsed.verdict) is true.
// Returns { pass: true } with no calibration when no threshold is configured
// (legacy pass). When a threshold is set, returns the deterministic outcome
// and attaches the calibration sub-object so the caller can persist it.
export function calibrateVerdict(
  parsed: GateVerdict,
  calibration:
    | { confidence_min?: number; allow_missing_confidence?: boolean }
    | undefined,
): { pass: boolean; calibration?: GateVerdict["calibration"] } {
  if (calibration?.confidence_min === undefined) {
    // No threshold configured — legacy pass, no calibration recorded.
    return { pass: true };
  }

  const confidenceMin = calibration.confidence_min;
  const rawVerdict = parsed.verdict!;

  if (typeof parsed.confidence === "number") {
    // Agent-emitted confidence MUST lie in the documented 0..1 domain. A
    // malformed value (NaN, ±Infinity, <0, >1) is fail-closed as
    // `invalid_confidence` — it must NEVER clear the threshold (e.g. `2 >= 0.8`)
    // and must NOT be rescued by allow_missing_confidence (it is present, just
    // out of range). config-side confidence_min is already bounded by zod
    // (config.schema.ts z.number().min(0).max(1)); this guards the untrusted side.
    if (
      !Number.isFinite(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 1
    ) {
      return {
        pass: false,
        calibration: {
          confidenceMin,
          rawVerdict,
          outcome: "invalid_confidence",
        },
      };
    }

    if (parsed.confidence >= confidenceMin) {
      return {
        pass: true,
        calibration: { confidenceMin, rawVerdict, outcome: "above_threshold" },
      };
    }

    return {
      pass: false,
      calibration: { confidenceMin, rawVerdict, outcome: "below_threshold" },
    };
  }

  // Confidence absent.
  if (calibration.allow_missing_confidence === true) {
    return {
      pass: true,
      calibration: {
        confidenceMin,
        rawVerdict,
        outcome: "missing_confidence_allowed",
      },
    };
  }

  return {
    pass: false,
    calibration: { confidenceMin, rawVerdict, outcome: "no_confidence" },
  };
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
  // M38 (ADR-103): when the node routes on a verdict, the verdict-producing gate
  // is routing-input — it never sets blockingFailedGateId, and its calibrated
  // verdict is surfaced to the caller for the `decide` table.
  const verdictRouting = node.decide?.from === "verdict";
  let routedVerdict: GateVerdict | undefined;

  // Execution-policy check-strictness (axis A3): advisory/skip relax the
  // non-review check gates so a failed one no longer aborts the node finish.
  // The judge→rework loop (ai_judgment/human_review) is never relaxed here.
  // Fail-closed to strict on a null/malformed snapshot.
  const checks = checksFromSnapshot(loaded.run.executionPolicy ?? null);

  for (const gate of node.gates) {
    const verdictSink: { verdict?: GateVerdict } = {};
    const status = await runOneGate(
      gate,
      node,
      nodeAttemptId,
      loaded,
      context,
      ctx,
      checks,
      verdictSink,
    );

    const isVerdictGate =
      gate.kind === "ai_judgment" || gate.kind === "skill_check";

    if (verdictRouting && isVerdictGate && verdictSink.verdict !== undefined) {
      routedVerdict = verdictSink.verdict;
    }

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

    const effectiveBlocking = isEffectivelyBlockingGate(
      checks,
      gate.kind,
      gate.mode,
    );

    // An author-`blocking` non-review check gate that policy relaxed is recorded
    // for audit but does not block the node finish — surface it through the
    // exec-policy audit boundary.
    if (gate.mode === "blocking" && !effectiveBlocking) {
      logExecPolicyAction({
        runId: loaded.run.id,
        kind: "check_downgraded",
        detail: {
          nodeId: node.id,
          gateId: gate.id,
          kind: gate.kind,
          from: "blocking",
          to: checks,
          status,
        },
      });
    }

    // M38: a verdict-producing gate on a `decide:{from:verdict}` node is
    // routing-input — its (possibly low-confidence) verdict drives the decide
    // table, so it MUST NOT abort the node finish. The decide table owns the
    // approve/review/rework decision; the verdict is surfaced above.
    //
    // BUT only when it actually PRODUCED a verdict. A failed routing-input gate
    // (no prompt, or unparseable agent output) surfaced none — `routedVerdict`
    // stays undefined, so `computeDecideOutcome` would fall through to the
    // decide `default` branch and let a broken producer drive business routing
    // (e.g. an approve/promote default). With no verdict there is nothing to
    // route on, so fail closed: a failed routing-input gate is a blocking gate
    // failure (the node Fails) exactly like any other unproducible blocking gate.
    const routingInputWithVerdict =
      verdictRouting && isVerdictGate && verdictSink.verdict !== undefined;

    if (
      effectiveBlocking &&
      status === "failed" &&
      !blockingFailedGateId &&
      !routingInputWithVerdict
    ) {
      blockingFailedGateId = gate.id;
      // Keep running the remaining gates so all verdicts are recorded for the
      // attempt, but the node will not finish (caller aborts).
    }
  }

  // M38 (ADR-103) fail-closed invariant: a `decide:{from:verdict}` node MUST
  // surface a verdict to route on. If the gate loop produced none, there is
  // nothing to route on and `computeDecideOutcome` would fall through to the
  // decide `default` branch (often an approve/promote) — a broken/relaxed
  // producer driving business routing. The per-gate guard above only fires for
  // an effectively-blocking gate, so on its own it misses a verdict gate that is
  // `advisory`, downgraded by execution-policy check-strictness, or skipped
  // entirely (a blocking `skill_check` under checks=advisory/skip). Close every
  // no-verdict vector here uniformly: fail the node closed, exactly as the
  // blocking path does. (verifyDecideAndOnMismatch guarantees exactly one
  // verdict gate on a from:verdict node, so this find is always defined.)
  if (verdictRouting && routedVerdict === undefined && !blockingFailedGateId) {
    blockingFailedGateId = node.gates.find(
      (g) => g.kind === "ai_judgment" || g.kind === "skill_check",
    )?.id;
  }

  return {
    ok: blockingFailedGateId === undefined,
    blockingFailedGateId,
    verdict: routedVerdict,
  };
}

async function runOneGate(
  gate: GateDef,
  node: CompiledNode,
  nodeAttemptId: string,
  loaded: LoadedRun,
  context: FlowContext,
  ctx: GateRunContext,
  checks: CheckStrictness,
  // M38 (ADR-103): a mutable sink the ai_judgment/skill_check arm writes the
  // parsed verdict into, so `runNodeGates` can surface it for a `decide` table
  // WITHOUT a gate_results re-read. Undefined for callers that don't route.
  verdictSink?: { verdict?: GateVerdict },
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

  // Execution-policy check-strictness `skip` (axis A3): a non-review check gate
  // is not evaluated. Record it `skipped` (never silently absent — same
  // discipline as the human_review/default arms) so the evidence graph shows
  // the policy decision.
  if (isPolicySkippedGate(checks, gate.kind)) {
    const { id } = await createGateResult({ ...base, status: "running" });

    await markGateSkipped(
      id,
      {
        verdict: "skipped",
        reasons: ["execution policy checks=skip: gate not evaluated"],
      },
      ctx.db,
    );

    return "skipped";
  }

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

      // M38 (ADR-103): surface the parsed verdict (pass OR fail, with confidence)
      // so a `decide:{from:verdict}` node can route on it even when calibration
      // would otherwise have failed the gate.
      if (verdictSink) verdictSink.verdict = verdict;

      // M38 (ADR-103): under `decide:{from:verdict}` the gate is ROUTING-INPUT —
      // producing a parseable verdict IS success. Record it `passed` (the verdict
      // value is retained in gate_results.verdict for routing + audit) so it never
      // hard-fails the node finish OR blocks review-readiness; the decide table
      // owns the approve/review/rework decision. confidence_min calibration is
      // irrelevant here — the `when` predicates do the thresholding.
      if (node.decide?.from === "verdict") {
        await markGatePassed(id, verdict, ctx.db);

        return "passed";
      }

      if (isPassVerdict(verdict.verdict ?? "")) {
        const cal = calibrateVerdict(verdict, gate.calibration);

        if (cal.calibration?.outcome === "invalid_confidence") {
          log.warn(
            {
              runId: loaded.run.id,
              nodeId: node.id,
              gateId: gate.id,
              confidence: verdict.confidence,
            },
            "gate verdict confidence outside 0..1 domain — failing closed (invalid_confidence)",
          );
        }

        const verdictToStore = cal.calibration
          ? { ...verdict, calibration: cal.calibration }
          : verdict;

        if (cal.pass) {
          await markGatePassed(id, verdictToStore, ctx.db);

          return "passed";
        }

        await markGateFailed(id, verdictToStore, ctx.db);

        return "failed";
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
        // M29 (ADR-074): mutation assertions evaluate AFTER the input-presence
        // check; gates without assertions take the unchanged path below.
        if (
          gate.must_touch !== undefined ||
          gate.must_not_touch !== undefined
        ) {
          return runMutationAssertionGate(
            gate,
            node,
            nodeAttemptId,
            loaded,
            ctx,
            id,
            `all ${requiredIds.length} required artifact(s) present and current`,
          );
        }

        // Back-ref BEFORE the terminal transition (same crash-window rule as
        // runMutationAssertionGate): a death here leaves the gate `running`
        // for re-execution instead of a terminal row missing the back-ref.
        if (outputRef) {
          const { gateResults } = schemaModule as unknown as Record<
            string,
            any
          >;

          await ctx.db
            .update(gateResults)
            .set({ outputArtifactRef: outputRef })
            .where(eq(gateResults.id, id));

          log.debug(
            { gateId: gate.id, gateResultId: id, outputArtifactRef: outputRef },
            "gate output back-ref recorded",
          );
        }

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

// M29 (ADR-074): evaluate must_touch/must_not_touch on an artifact_required
// gate whose input-presence check already passed. ALWAYS records the
// mutation_report artifact (pass AND fail, evaluated or not) BEFORE the
// terminal gate transition — a crash between leaves the gate `running`, so a
// rework re-executes it (same crash-window shape as the existing sequence).
async function runMutationAssertionGate(
  gate: GateDef,
  node: CompiledNode,
  nodeAttemptId: string,
  loaded: LoadedRun,
  ctx: GateRunContext,
  gateResultId: string,
  presenceReason: string,
): Promise<"passed" | "failed"> {
  const branch = loaded.workspace.branch;
  // Cumulative range (merge-base vs main → head SHA) — shared resolution with
  // the diff artifact (byte-identical fallbacks, D-C3).
  const cumulative = await resolveDiffRange({
    worktreePath: ctx.worktreePath,
    branch,
  });

  const runDir = runDirPath(ctx.runtimeRoot, loaded.projectSlug, loaded.run.id);
  const startHead = await readNodeStartHead(runDir, node.id);
  const basis =
    startHead !== null ? ("node" as const) : ("cumulative-fallback" as const);
  const nodeBase = startHead ?? cumulative.base;

  let evaluated = cumulative.evaluated;
  let nodeTouched: string[] = [];
  let cumulativeTouched: string[] = [];

  if (evaluated) {
    try {
      nodeTouched = await touchedPaths(
        ctx.worktreePath,
        nodeBase,
        cumulative.head,
      );
      cumulativeTouched =
        gate.must_not_touch === undefined
          ? []
          : basis === "node"
            ? await touchedPaths(
                ctx.worktreePath,
                cumulative.base,
                cumulative.head,
              )
            : nodeTouched;
    } catch (err) {
      // Refs resolved but the diff failed — a sensor that cannot sense must
      // not pass (D-C3): same handling as git-unavailable.
      evaluated = false;
      log.warn(
        {
          runId: loaded.run.id,
          gateId: gate.id,
          nodeId: node.id,
          err: (err as Error).message,
        },
        "git diff failed — mutation assertions not evaluated",
      );
    }
  }

  const { pass, report } = evaluateMutationAssertions({
    nodeTouched,
    cumulativeTouched,
    mustTouch: gate.must_touch,
    mustNotTouch: gate.must_not_touch,
    restrictionSets: ctx.restrictionPaths,
    basis,
    nodeRange: { base: nodeBase, head: cumulative.head },
    cumulativeRange: { base: cumulative.base, head: cumulative.head },
    evaluated,
  });

  // D-C4: record the report BEFORE the terminal gate transition. hash +
  // size_bytes get their first writer here; artifactDefId only when the gate
  // declares an output (its kind is schema-forced to mutation_report).
  const text = JSON.stringify(report);
  const declaredOutputId = gate.output?.id;

  await recordCurrentArtifact(
    {
      ...(declaredOutputId === undefined
        ? { id: `run:${nodeAttemptId}:mutation:${gate.id}` }
        : {}),
      runId: loaded.run.id,
      nodeAttemptId,
      nodeId: node.id,
      artifactDefId: declaredOutputId ?? null,
      kind: "mutation_report",
      producer: "gate",
      locator: { kind: "inline", text },
      hash: createHash("sha256").update(text).digest("hex"),
      sizeBytes: Buffer.byteLength(text, "utf8"),
      validity: "current",
    },
    ctx.db,
  );

  // Back-ref BEFORE the terminal transition, same crash-window shape as the
  // report itself: a death here leaves the gate `running` and re-execution
  // re-sets it; written after the transition, a crash in between would leave
  // a terminal gate permanently missing the back-ref.
  if (declaredOutputId !== undefined) {
    const { gateResults } = schemaModule as unknown as Record<string, any>;

    await ctx.db
      .update(gateResults)
      .set({ outputArtifactRef: declaredOutputId })
      .where(eq(gateResults.id, gateResultId));

    log.debug(
      { gateId: gate.id, gateResultId, outputArtifactRef: declaredOutputId },
      "mutation gate output back-ref recorded",
    );
  }

  log.info(
    {
      runId: loaded.run.id,
      gateId: gate.id,
      nodeId: node.id,
      touched: report.touched.length,
      violations: report.violations,
      evaluated: report.evaluated,
    },
    "mutation report",
  );

  if (pass) {
    await markGatePassed(
      gateResultId,
      {
        verdict: "pass",
        reasons: [presenceReason, "mutation assertions passed"],
      },
      ctx.db,
    );
  } else {
    if (gate.mode === "advisory") {
      log.warn(
        {
          runId: loaded.run.id,
          gateId: gate.id,
          nodeId: node.id,
          violations: report.violations,
        },
        "advisory mutation assertion failed — node proceeds",
      );
    }

    await markGateFailed(
      gateResultId,
      {
        verdict: "fail",
        reasons: report.violations,
        payload: { assertionFailed: true },
      },
      ctx.db,
    );
  }

  return pass ? "passed" : "failed";
}
