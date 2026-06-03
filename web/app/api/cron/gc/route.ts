import "server-only";

import type { RevisionGcSummary } from "@/lib/gc/revision-gc";
import type { WorkspaceGcSummary } from "@/lib/gc/workspace-gc";

import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { runCapabilitiesCleanupSweep } from "@/lib/capabilities/cleanup";
import { runRevisionGcSweep } from "@/lib/gc/revision-gc";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";

const log = pino({
  name: "cron-gc",
  level: process.env.LOG_LEVEL ?? "info",
});

const CRON_TOKEN_HEADER = "X-Maister-Cron-Token";

// Constant-time token compare. Length mismatch makes timingSafeEqual throw, so
// guard it and return false (a mismatch). Never log or echo the token.
function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  try {
    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(expected);

    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = process.env.MAISTER_CRON_TOKEN;

  if (!token) {
    return NextResponse.json(
      {
        code: "CONFIG",
        message: "MAISTER_CRON_TOKEN is unset — cron disabled",
      },
      { status: 503 },
    );
  }

  if (!tokenMatches(req.headers.get(CRON_TOKEN_HEADER), token)) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "missing or invalid cron token" },
      { status: 401 },
    );
  }

  // Both sweeps run INDEPENDENTLY (own try/catch). The route projects the two
  // sub-summaries into the flat GcSweepSummary contract and returns 207 whenever
  // a sub-sweep THREW or CAUGHT per-row failures (workspace
  // skippedUnpreserved/failed OR revision cache-dir rm failed) — a cron monitor
  // must NOT read 200 while worktrees were left unpreserved/unpruned or revision
  // cache dirs were orphaned on disk. `skippedReferenced` is NOT an error: a
  // still-referenced revision is correctly retained, not a failure.
  const errors: string[] = [];
  let workspace: WorkspaceGcSummary | null = null;
  let revision: RevisionGcSummary | null = null;
  let capabilities: Awaited<
    ReturnType<typeof runCapabilitiesCleanupSweep>
  > | null = null;

  try {
    workspace = await runWorkspaceGcSweep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    errors.push(`workspace sweep failed: ${message}`);
    log.error({ err: message }, "cron GC: workspace sweep threw");
  }

  try {
    revision = await runRevisionGcSweep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    errors.push(`revision sweep failed: ${message}`);
    log.error({ err: message }, "cron GC: revision sweep threw");
  }

  try {
    capabilities = await runCapabilitiesCleanupSweep();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    errors.push(`capabilities sweep failed: ${message}`);
    log.error({ err: message }, "cron GC: capabilities sweep threw");
  }

  if (workspace && workspace.skippedUnpreserved > 0) {
    errors.push(
      `${workspace.skippedUnpreserved} workspace(s) skipped: preserve failed (left for retry)`,
    );
  }
  if (workspace && workspace.failed > 0) {
    errors.push(`${workspace.failed} workspace(s) errored during GC`);
  }
  if (revision && revision.failed > 0) {
    errors.push(
      `${revision.failed} revision cache dir(s) failed to remove (row deleted, dir orphaned on disk)`,
    );
  }
  if (capabilities && capabilities.failed > 0) {
    errors.push(
      `${capabilities.failed} capability dir(s) failed to remove (left for retry)`,
    );
  }

  // The capabilities sweep result stays out of the GcSweepSummary response DTO
  // (OpenAPI: worktrees/revisions + errors only); it surfaces via this log line
  // and a 207-triggering error on partial failure, mirroring the revision sweep.
  const summary = {
    worktreesPreserved: workspace?.preserved ?? 0,
    worktreesRemoved: workspace?.pruned ?? 0,
    revisionsRemoved: revision?.deleted ?? 0,
    errors,
  };

  log.info(
    { ...summary, capabilities, errorCount: errors.length },
    "cron GC sweep completed",
  );

  return NextResponse.json(summary, {
    status: errors.length > 0 ? 207 : 200,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
