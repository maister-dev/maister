import "server-only";

import type { ArtifactLocator } from "@/lib/db/schema";
import type {
  PublicRunResult,
  ResultStatus,
  RunResultContract,
  RunResultInvalidReason,
} from "@/lib/run-results/types";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { SETTLED_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import {
  markRunResultCollected,
  resolvePublicResult,
} from "@/lib/run-results/ledger";
import { deriveResultStatus } from "@/lib/run-results/status";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { artifactInstances, runs } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-result-collect",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165 (T7.1 / D12): the `run_collect` assembly. Extracted from the route so
// the route stays thin (parse, auth, call, map) and the projection has one
// owner. Every field is derived from server state; nothing here reads a request
// payload.

export type CollectArtifact = {
  id: string;
  kind: string;
  name: string;
  nodeId: string | null;
  validity: string;
};

export type CollectResult = {
  childRunId: string;
  status: string;
  settled: boolean;
  resultStatus: ResultStatus;
  result: PublicRunResult | null;
  resultRevision: number | null;
  resultFailure: { reason: RunResultInvalidReason; message: string } | null;
  artifacts: CollectArtifact[];
  diffRef?: string;
  outputText?: string;
};

// A human-readable name from the artifact's locator/uri — NEVER an internal
// handle. Mirrors the DTO projection rule (no acp_session_id, no raw paths the
// orchestrator should not see).
function artifactName(locator: ArtifactLocator, uri: string | null): string {
  switch (locator.kind) {
    case "file":
      return locator.path;
    case "git-range":
      return `${locator.baseCommit.slice(0, 12)}..${locator.headRef}`;
    case "git-log":
      return `${locator.baseRef}..${locator.headRef}`;
    case "gate-verdict":
      return `gate:${locator.gateResultId}`;
    case "hitl-response":
      return `hitl:${locator.hitlRequestId}`;
    case "inline":
      return uri ?? "inline";
    default:
      return uri ?? "artifact";
  }
}

function diffRefFromLocator(locator: ArtifactLocator): string | undefined {
  if (locator.kind === "git-range") return locator.headRef;
  if (locator.kind === "git-log") return locator.headRef;

  return undefined;
}

type ArtifactRow = {
  id: string;
  kind: string;
  locator: ArtifactLocator;
  uri: string | null;
  nodeId: string | null;
  validity: string;
  createdAt: Date;
};

/**
 * The child's legacy terminal text.
 *
 * DEPRECATED in favour of `result.value`, and now DETERMINISTIC: the rows are
 * ordered newest-first by the query, so two qualifying inline artifacts always
 * yield the same answer. It used to take whichever row the planner happened to
 * return, which made the field unusable as a contract.
 */
function outputTextFromArtifacts(rows: ArtifactRow[]): string | undefined {
  const textual = rows.find(
    (r) =>
      r.locator.kind === "inline" &&
      (r.kind === "log" || r.kind === "human_note" || r.kind === "ai_judgment"),
  );

  return textual && textual.locator.kind === "inline"
    ? textual.locator.text
    : undefined;
}

const SETTLED: ReadonlySet<string> = new Set(SETTLED_RUN_STATUSES);

/**
 * Assemble one child summary.
 *
 * Refuses `PRECONDITION` when the run is not a DIRECT child of `parentRunId` in
 * `projectId` — the same message for "not yours" and "does not exist", so the
 * route never confirms another tree's run ids. This replaces the old
 * `"unknown"` status fallback, which reported a fictional child rather than
 * refusing.
 */
/**
 * What `collectChild` returns: the wire DTO plus the ledger row id that was
 * actually served.
 *
 * `servedResultId` is deliberately NOT a field of `CollectResult` — that type is
 * the public response body, and a ledger row id is an internal handle. It exists
 * so the first-collected marker can target the EXACT revision the caller
 * received rather than "whatever is valid at write time".
 */
export type CollectedChild = {
  result: CollectResult;
  servedResultId: string | null;
};

export async function collectChild(
  db: Db,
  args: { parentRunId: string; projectId: string; childRunId: string },
): Promise<CollectedChild> {
  const runRows = (await db
    .select({
      status: runs.status,
      resultContract: runs.resultContract,
    })
    .from(runs)
    .where(
      and(
        eq(runs.id, args.childRunId),
        eq(runs.parentRunId, args.parentRunId),
        eq(runs.projectId, args.projectId),
      ),
    )) as { status: string; resultContract: RunResultContract | null }[];
  const run = runRows[0];

  if (!run) {
    throw new MaisterError(
      "PRECONDITION",
      "run is not a child of the bound orchestrator run",
    );
  }

  const artifactRows = (await db
    .select({
      id: artifactInstances.id,
      kind: artifactInstances.kind,
      locator: artifactInstances.locator,
      uri: artifactInstances.uri,
      nodeId: artifactInstances.nodeId,
      validity: artifactInstances.validity,
      createdAt: artifactInstances.createdAt,
    })
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.runId, args.childRunId),
        eq(artifactInstances.validity, "current"),
      ),
    )
    .orderBy(desc(artifactInstances.createdAt))) as ArtifactRow[];

  const { newest, valid } = await resolvePublicResult(db, args.childRunId);
  const resultStatus = deriveResultStatus({
    runStatus: run.status,
    contract: run.resultContract,
    newestRow: newest,
    validRow: valid,
  });

  const diffRow = artifactRows.find((r) => r.kind === "diff");
  const diffRef = diffRow ? diffRefFromLocator(diffRow.locator) : undefined;
  const outputText = outputTextFromArtifacts(artifactRows);

  const servedRow = resultStatus === "valid" ? valid : null;

  return {
    servedResultId: servedRow?.id ?? null,
    result: {
      childRunId: args.childRunId,
      status: run.status,
      settled: SETTLED.has(run.status),
      resultStatus,
      result: servedRow
        ? { schemaRef: servedRow.schemaRef, value: servedRow.value }
        : null,
      resultRevision: valid?.revision ?? newest?.revision ?? null,
      // The invalid row is the ONE durable source. A failure-terminal child that
      // simply died (W4) has none, and reports null rather than a guess.
      resultFailure:
        newest?.validity === "invalid" && newest.invalidReason
          ? {
              reason: newest.invalidReason,
              message: invalidReasonMessage(newest.invalidReason),
            }
          : null,
      artifacts: artifactRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: artifactName(row.locator, row.uri),
        nodeId: row.nodeId,
        validity: row.validity,
      })),
      ...(diffRef !== undefined ? { diffRef } : {}),
      ...(outputText !== undefined ? { outputText } : {}),
    },
  };
}

/** A stable, operator-readable sentence per reason class. */
function invalidReasonMessage(reason: RunResultInvalidReason): string {
  switch (reason) {
    case "result_missing":
      return "the run finished without publishing the public result its contract requires";
    case "malformed_json":
      return "the published result was not valid JSON";
    case "oversize":
      return "the published result exceeded the payload size limit";
    case "unsafe_key":
      return "the published result contained an unsafe object key";
    case "depth_limit":
      return "the published result exceeded the nesting depth limit";
    case "key_limit":
      return "the published result exceeded the object key limit";
    case "array_limit":
      return "the published result exceeded the array length limit";
    case "schema_mismatch":
      return "the published result did not satisfy its declared schema";
  }
}

/** The bound orchestrator's DIRECT children, in insertion order. */
export async function directChildRunIds(
  db: Db,
  args: { parentRunId: string; projectId: string },
): Promise<string[]> {
  const rows = (await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, args.parentRunId),
        eq(runs.projectId, args.projectId),
      ),
    )) as { id: string }[];

  return rows.map((r) => r.id);
}

/**
 * Stamp `first_collected_at` on every VALID result served, in ONE transaction
 * committed BEFORE the response (W6).
 *
 * Write-once by the ledger's `IS NULL` guard, so a repeated collect returns an
 * identical body and never moves the marker — which is what makes this half of
 * the Lab's consumption metric mean "the first time the engine served it".
 */
export async function markCollected(
  db: Db,
  collected: readonly CollectedChild[],
): Promise<void> {
  const served = collected.filter(
    (c): c is CollectedChild & { servedResultId: string } =>
      c.result.resultStatus === "valid" && c.servedResultId !== null,
  );

  if (served.length === 0) return;

  await db.transaction(async (tx: Db) => {
    for (const item of served) {
      // Keyed on the SERVED row, not the run: a rework that superseded it and
      // published a new revision between the read above and this write must not
      // have the new revision stamped as the one the caller received.
      await markRunResultCollected(
        tx,
        item.result.childRunId,
        item.servedResultId,
      );
    }
  });

  log.debug(
    { count: served.length },
    "[run-result.collect] first-collected markers stamped",
  );
}
