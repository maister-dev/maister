import "server-only";

import type { ArtifactLocator } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { artifactInstances, runs } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const ENDPOINT = "POST /api/v1/ext/runs/collect";

const bodySchema = z
  .object({
    childRunId: z.string().min(1).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.childRunId !== undefined || b.all === true, {
    message: "either childRunId or all:true is required",
  });

type CollectBody = z.infer<typeof bodySchema>;

type CollectArtifact = { id: string; kind: string; name: string };

type CollectResult = {
  childRunId: string;
  status: string;
  outputText?: string;
  artifacts: CollectArtifact[];
  diffRef?: string;
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

// The child's terminal text output, when an inline-text artifact carries it.
// `{{ steps.<id>.output }}` is stdout text; it materializes as an `inline`
// locator when the producer recorded it. When no such artifact exists the field
// is omitted — we never read the child worktree or per-step log files directly.
function outputTextFromArtifacts(
  rows: { kind: string; locator: ArtifactLocator }[],
): string | undefined {
  const textual = rows.find(
    (r) =>
      r.locator.kind === "inline" &&
      (r.kind === "log" || r.kind === "human_note" || r.kind === "ai_judgment"),
  );

  return textual && textual.locator.kind === "inline"
    ? textual.locator.text
    : undefined;
}

async function collectOne(db: Db, runId: string): Promise<CollectResult> {
  const runRows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));
  const status = runRows[0]?.status ?? "unknown";

  const artifactRows = (await db
    .select({
      id: artifactInstances.id,
      kind: artifactInstances.kind,
      locator: artifactInstances.locator,
      uri: artifactInstances.uri,
    })
    .from(artifactInstances)
    .where(
      and(
        eq(artifactInstances.runId, runId),
        eq(artifactInstances.validity, "current"),
      ),
    )) as {
    id: string;
    kind: string;
    locator: ArtifactLocator;
    uri: string | null;
  }[];

  const artifacts: CollectArtifact[] = artifactRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: artifactName(row.locator, row.uri),
  }));

  const diffRow = artifactRows.find((r) => r.kind === "diff");
  const diffRef = diffRow ? diffRefFromLocator(diffRow.locator) : undefined;
  const outputText = outputTextFromArtifacts(artifactRows);

  return {
    childRunId: runId,
    status,
    ...(outputText !== undefined ? { outputText } : {}),
    artifacts,
    ...(diffRef !== undefined ? { diffRef } : {}),
  };
}

export async function POST(
  req: NextRequest,
  _routeCtx: object,
): Promise<NextResponse> {
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      scopeLabel: "runs:collect",
      endpoint: ENDPOINT,
      method: "POST",
      db,
    },
    async (ctx) => {
      let body: CollectBody;

      try {
        body = bodySchema.parse(await req.json());
      } catch (err) {
        return NextResponse.json(
          {
            code: "CONFIG",
            message: `invalid body: ${(err as Error).message}`,
          },
          { status: 422 },
        );
      }

      const parentRunId = ctx.actor.boundRunId;

      if (!parentRunId) {
        return NextResponse.json(
          {
            code: "PRECONDITION",
            message: "collect requires a run-bound orchestrator token",
          },
          { status: httpStatusForExtCode("PRECONDITION") },
        );
      }

      let childRunIds: string[];

      if (body.childRunId) {
        // Verify the named child is actually a child of THIS orchestrator and
        // in the token's project before exposing anything about it.
        const rows = await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, body.childRunId),
              eq(runs.parentRunId, parentRunId),
              eq(runs.projectId, ctx.projectId),
            ),
          );

        if (rows.length === 0) {
          return NextResponse.json(
            {
              code: "PRECONDITION",
              message: "run is not a child of the bound orchestrator run",
            },
            { status: httpStatusForExtCode("PRECONDITION") },
          );
        }

        childRunIds = [body.childRunId];
      } else {
        const rows = (await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.parentRunId, parentRunId),
              eq(runs.projectId, ctx.projectId),
            ),
          )) as { id: string }[];

        childRunIds = rows.map((r) => r.id);
      }

      const results: CollectResult[] = [];

      for (const id of childRunIds) {
        results.push(await collectOne(db, id));
      }

      return NextResponse.json(results, { status: 200 });
    },
  );
}
