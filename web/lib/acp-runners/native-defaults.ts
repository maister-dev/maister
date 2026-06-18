import "server-only";

import type { SupervisorDiagnostics } from "@/lib/supervisor-client";
import type { Logger } from "pino";

import { eq } from "drizzle-orm";
import pino from "pino";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
import { platformRunnerPresetRows } from "@/lib/acp-runners/presets";
import { evaluateRunnerReadiness } from "@/lib/acp-runners/readiness";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { platformAcpRunners, platformRouterSidecars, platformRuntimeSettings } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

const defaultLog = pino({
  name: "reconcile-platform-runners",
  level: process.env.LOG_LEVEL ?? "info",
});

// Native default runner id per adapter = the preset row for that adapter's
// native provider (ADR-093). Materialized only when the adapter binary is
// reported available by supervisor diagnostics.
export const nativeDefaultRunnerByAdapter: Record<AdapterId, string> = {
  claude: "claude-code",
  codex: "codex-openai",
  gemini: "gemini-cli",
  opencode: "opencode-native",
  mimo: "mimo-code-native",
};

// Deterministic platform-default preference order (ADR-093). The singleton
// default is set to the first Ready native default in this order.
const ADAPTER_DEFAULT_PREFERENCE: readonly AdapterId[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "mimo",
];

function sameReasons(
  next: readonly string[],
  current: readonly string[] | null | undefined,
): boolean {
  const prev = current ?? [];

  if (next.length !== prev.length) return false;

  return next.every((reason, index) => reason === prev[index]);
}

/**
 * Reconcile the platform ACP runner catalog against live supervisor diagnostics
 * (ADR-093). Runs at admin `/settings` load and is the single writer of
 * `readiness_status` outside the create/edit path:
 *
 * 1. Upsert-if-absent each AVAILABLE adapter's native default runner.
 * 2. Recompute readiness for ALL rows; persist only when status/reasons changed.
 * 3. Create the `platform_runtime_settings` singleton (pointing at the first
 *    Ready native default) when none exists yet — `default_runner_id` is
 *    NOT NULL, so the pre-config state is an absent singleton, not a null column.
 *
 * Never auto-deletes. When diagnostics are unavailable (null) it is a no-op so a
 * transient supervisor outage does not clobber last-known readiness to NotReady.
 * Idempotent and convergent: concurrent reconciles with the same diagnostics
 * reach the same state (upsert/update-if-changed/insert-if-absent only).
 */
export async function reconcilePlatformRunners(args: {
  db: Db;
  diagnostics: SupervisorDiagnostics | null;
  logger?: Logger;
}): Promise<void> {
  const { db, diagnostics } = args;
  const log = args.logger ?? defaultLog;

  if (!diagnostics) {
    log.info(
      {},
      "[reconcilePlatformRunners] diagnostics unavailable; skip (preserve last-known readiness)",
    );

    return;
  }

  const availableAdapters = (diagnostics.adapters ?? [])
    .filter((adapter) => adapter.available)
    .map((adapter) => adapter.id);

  log.debug({ availableAdapters }, "[reconcilePlatformRunners] entry");

  // 1. Materialize the native default for each available adapter.
  const presetById = new Map(
    platformRunnerPresetRows().map((preset) => [preset.id, preset]),
  );

  for (const adapter of ADAPTER_IDS) {
    if (!availableAdapters.includes(adapter)) continue;
    const preset = presetById.get(nativeDefaultRunnerByAdapter[adapter]);

    if (!preset) continue;

    const inserted = await db
      .insert(platformAcpRunners)
      .values({
        id: preset.id,
        adapter: preset.adapter,
        capabilityAgent: preset.capabilityAgent,
        model: preset.model,
        provider: preset.provider,
        permissionPolicy: preset.permissionPolicy,
        sidecarId: preset.sidecarId ?? null,
        enabled: preset.enabled,
        readinessStatus: "Unknown",
        readinessReasons: [],
      })
      .onConflictDoNothing()
      .returning({ id: platformAcpRunners.id });

    log.debug(
      { adapter, runnerId: preset.id, inserted: inserted.length > 0 },
      "[reconcilePlatformRunners] native default upsert",
    );
  }

  // 2. Recompute readiness for every row; persist only on change.
  const [runnerRows, sidecarRows] = await Promise.all([
    db.select().from(platformAcpRunners),
    db.select().from(platformRouterSidecars),
  ]);
  const sidecarById = new Map<string, any>(
    sidecarRows.map((row: any) => [row.id, row]),
  );
  const computedReadiness = new Map<
    string,
    { status: string; enabled: boolean }
  >();

  for (const runner of runnerRows) {
    const sidecar = runner.sidecarId
      ? (sidecarById.get(runner.sidecarId) ?? null)
      : null;
    const readiness = evaluateRunnerReadiness({
      runner: {
        adapter: runner.adapter,
        capabilityAgent: runner.capabilityAgent,
        enabled: runner.enabled,
        permissionPolicy: runner.permissionPolicy,
        provider: runner.provider,
        sidecarId: runner.sidecarId ?? null,
      },
      diagnostics,
      sidecar,
    });

    computedReadiness.set(runner.id, {
      status: readiness.status,
      enabled: runner.enabled,
    });

    if (
      readiness.status === runner.readinessStatus &&
      sameReasons(readiness.reasons, runner.readinessReasons)
    ) {
      continue;
    }

    await db
      .update(platformAcpRunners)
      .set({
        readinessStatus: readiness.status,
        readinessReasons: readiness.reasons,
        updatedAt: new Date(),
      })
      .where(eq(platformAcpRunners.id, runner.id));

    log.debug(
      {
        runnerId: runner.id,
        from: runner.readinessStatus,
        to: readiness.status,
        reasons: readiness.reasons,
      },
      "[reconcilePlatformRunners] readiness change",
    );
  }

  // 3. Create the platform-default singleton if absent and a Ready default exists.
  const runtimeRows = await db
    .select()
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));

  if (runtimeRows.length > 0) return;

  let chosenDefault: string | null = null;

  for (const adapter of ADAPTER_DEFAULT_PREFERENCE) {
    const runnerId = nativeDefaultRunnerByAdapter[adapter];
    const computed = computedReadiness.get(runnerId);

    if (computed?.enabled && computed.status === "Ready") {
      chosenDefault = runnerId;
      break;
    }
  }

  if (!chosenDefault) return;

  await db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: chosenDefault })
    .onConflictDoNothing();

  log.info(
    { defaultRunnerId: chosenDefault },
    "[reconcilePlatformRunners] platform default set",
  );
}
