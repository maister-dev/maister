import "server-only";

import type { ObjectiveFactSource } from "./providers";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): schema-module bridge (matches lib/evaluations/objective/execute.ts).
const { gateResults, artifactInstances } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-objective-source",
  level: process.env.LOG_LEVEL ?? "info",
});

interface GateRow {
  gateId: string;
  status: string;
}

// Map recorded gate rows to the settled-verdict facts a provider may read (D11).
// ONLY `passed`/`failed` are objective verdicts; `pending`/`running`/`stale`/
// `skipped`/`overridden` are NOT verdicts and are excluded — never coerced to a
// pass. (Runs are terminal at evaluation time, so their gates are settled.)
export function mapGateVerdicts(
  rows: GateRow[],
): Array<{ gateId: string; status: "passed" | "failed" }> {
  const out: Array<{ gateId: string; status: "passed" | "failed" }> = [];

  for (const row of rows) {
    if (row.status === "passed")
      out.push({ gateId: row.gateId, status: "passed" });
    else if (row.status === "failed")
      out.push({ gateId: row.gateId, status: "failed" });
  }

  return out;
}

// Compute produced-artifact completeness against the required set (D11). Missing
// required artifacts are named explicitly; a satisfied set is `requiredPresent`.
export function resolveArtifactCompleteness(
  presentDefIds: Array<string | null>,
  requiredDefIds: string[],
): { requiredPresent: boolean; missing: string[] } {
  const present = new Set(
    presentDefIds.filter((id): id is string => Boolean(id)),
  );
  const missing = requiredDefIds.filter((id) => !present.has(id));

  return { requiredPresent: missing.length === 0, missing };
}

export interface LoadObjectiveFactSourceArgs {
  // The participant's Run whose recorded facts to read; null when the observed
  // Run link was removed → honest absence (no recorded facts).
  runId: string | null;
  // The manifest-required artifact def ids to check completeness against; omit to
  // leave completeness as honest absence (the provider reports `not_run`).
  requiredArtifactDefIds?: string[] | null;
  // Operator-registered trusted host-check profiles (platform-owned set).
  registeredHostProfiles?: Set<string>;
  // Per-participant source/diff statistics measured at capture (a metric, never a
  // verdict). Omit for honest absence (`diff_stats` reports `unavailable`).
  diffStats?: { files: number; additions: number; deletions: number } | null;
}

// Build the live ObjectiveFactSource for one participant Run from real readers
// (gate_results, artifact_instances) + supplied platform facts. The pure closed
// providers (providers.ts) then read these recorded facts; this layer NEVER
// infers a PASS from source appearance (D11) — a missing reader yields honest
// absence, not a fabricated verdict.
export async function loadObjectiveFactSource(
  args: LoadObjectiveFactSourceArgs,
  db?: Db,
): Promise<ObjectiveFactSource> {
  const registeredHostProfiles =
    args.registeredHostProfiles ?? new Set<string>();

  if (!args.runId) {
    return { registeredHostProfiles };
  }

  const d = db ?? getDb();

  const gateRows: GateRow[] = await d
    .select({ gateId: gateResults.gateId, status: gateResults.status })
    .from(gateResults)
    .where(eq(gateResults.runId, args.runId));

  const source: ObjectiveFactSource = {
    gateResults: mapGateVerdicts(gateRows),
    schemaContract: null,
    diffStats: args.diffStats ?? null,
    registeredHostProfiles,
  };

  if (args.requiredArtifactDefIds && args.requiredArtifactDefIds.length > 0) {
    const present: Array<{ artifactDefId: string | null }> = await d
      .select({ artifactDefId: artifactInstances.artifactDefId })
      .from(artifactInstances)
      .where(
        and(
          eq(artifactInstances.runId, args.runId),
          eq(artifactInstances.validity, "current"),
        ),
      );

    source.artifactCompleteness = resolveArtifactCompleteness(
      present.map((p) => p.artifactDefId),
      args.requiredArtifactDefIds,
    );
  }

  log.debug(
    {
      runId: args.runId,
      gateVerdicts: source.gateResults?.length ?? 0,
      artifactChecked: Boolean(args.requiredArtifactDefIds?.length),
    },
    "objective fact source loaded",
  );

  return source;
}
