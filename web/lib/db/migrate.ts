import "@/lib/load-env";

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import pino from "pino";

import {
  findMainMigrationJournalEntry,
  findPendingMigrations,
  mainMigrationLedgerHighWater,
} from "./check-migrations";
import {
  M43_CUTOVER_MIGRATION,
  readM43CutoverTelemetry,
  type M43CutoverTelemetry,
} from "./m43-cutover-telemetry";
import { createMigrationRootBefore } from "./m43-cutover-migration-root";
import { maskDbUrl, resolvePostgresDbUrl } from "./postgres-url";

import {
  GRAPH_ONLY_CUTOVER_REASON,
  GRAPH_ONLY_CUTOVER_SOURCE,
} from "@/lib/domain-events/cutover";

const log = pino({ name: "db:migrate" });
const MIGRATIONS_FOLDER = "./lib/db/migrations";
const MIGRATIONS_DIR = join(process.cwd(), "lib/db/migrations");
const STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION = "0134_lovely_tarot";

function canReadM43Telemetry(pending: readonly string[]): boolean {
  return pending[0] === M43_CUTOVER_MIGRATION;
}

function logM43CutoverTelemetry(telemetry: M43CutoverTelemetry): void {
  log.info(
    {
      migration: M43_CUTOVER_MIGRATION,
      candidateCount: telemetry.candidateCount,
      transitionedCount: telemetry.transitionedCount,
      nodeAttemptsClosed: telemetry.nodeAttemptsClosed,
      hitlRequestsCancelled: telemetry.hitlRequestsCancelled,
      assignmentsClosed: telemetry.assignmentsClosed,
      sessionsCleared: telemetry.sessionsCleared,
    },
    "M43 graph-only cut-over migration summary",
  );

  for (const candidate of telemetry.candidates) {
    log.warn(
      {
        migration: M43_CUTOVER_MIGRATION,
        runId: candidate.runId,
        priorStatus: candidate.priorStatus,
        reason: GRAPH_ONLY_CUTOVER_REASON,
        source: GRAPH_ONLY_CUTOVER_SOURCE,
      },
      "M43 graph-only cut-over transitioned run to Failed",
    );
  }
}

async function main(): Promise<void> {
  const url = resolvePostgresDbUrl();

  log.info({ driver: "postgres", url: maskDbUrl(url) }, "running migrations");
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  let preM43MigrationRoot: string | null = null;
  let preStageBMigrationRoot: string | null = null;
  let m43TelemetryLogged = false;

  try {
    const pending = await findPendingMigrations(db);
    const m43Pending = pending.includes(M43_CUTOVER_MIGRATION);
    const m43Entry = findMainMigrationJournalEntry(M43_CUTOVER_MIGRATION);

    if (!m43Entry) {
      throw new Error(
        `migration journal does not contain ${M43_CUTOVER_MIGRATION}`,
      );
    }

    if (m43Pending) {
      const highWater = await mainMigrationLedgerHighWater(db);

      if (highWater !== null && highWater >= m43Entry.when) {
        throw new Error(
          `cannot run ${M43_CUTOVER_MIGRATION}: its hash is missing but migration ledger high-water ${highWater} is at or after journal timestamp ${m43Entry.when}; repair the migration ledger before retrying`,
        );
      }
    }

    if (m43Pending && !canReadM43Telemetry(pending)) {
      preM43MigrationRoot = await createMigrationRootBefore(
        MIGRATIONS_DIR,
        M43_CUTOVER_MIGRATION,
      );
      await migrate(db, { migrationsFolder: preM43MigrationRoot });

      const remaining = await findPendingMigrations(db);

      if (remaining[0] !== M43_CUTOVER_MIGRATION) {
        throw new Error(
          `cannot capture M43 cut-over telemetry: expected ${M43_CUTOVER_MIGRATION} to be next, found ${remaining[0] ?? "no pending migration"}`,
        );
      }
    }

    const m43Telemetry = m43Pending ? await readM43CutoverTelemetry(db) : null;

    if (
      pending.includes(STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION) &&
      pending[0] !== STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION
    ) {
      preStageBMigrationRoot = await createMigrationRootBefore(
        MIGRATIONS_DIR,
        STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION,
      );
      await migrate(db, { migrationsFolder: preStageBMigrationRoot });

      if (m43Telemetry) {
        logM43CutoverTelemetry(m43Telemetry);
        m43TelemetryLogged = true;
      }

      const remaining = await findPendingMigrations(db);

      if (remaining[0] !== STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION) {
        throw new Error(
          `cannot stage the Stage B data-plane cut-over: expected ${STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION} to be next, found ${remaining[0] ?? "no pending migration"}`,
        );
      }

      log.info(
        { nextMigration: STAGE_B_DESTRUCTIVE_CUTOVER_MIGRATION },
        "Stage B additive data-plane migrations committed; validating destructive preservation cut-over",
      );
    }

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    if (m43Telemetry && !m43TelemetryLogged) {
      logM43CutoverTelemetry(m43Telemetry);
    }

    log.info("migrations done");
  } finally {
    if (preM43MigrationRoot) {
      await rm(preM43MigrationRoot, { force: true, recursive: true });
    }
    if (preStageBMigrationRoot) {
      await rm(preStageBMigrationRoot, { force: true, recursive: true });
    }
    await pool.end();
  }
}

main().catch((err) => {
  log.error({ err }, "migration failed");
  process.exit(1);
});
