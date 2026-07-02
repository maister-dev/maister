import "server-only";

import type { OpenAiCompatibleClient } from "@/lib/brain/openai-compatible";
import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "./consumers";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { getBrainEmbeddingClient } from "@/lib/brain/openai-compatible";
import { distill } from "@/lib/brain/distill";
import { isBrainProvisioned, isProjectBrainEnabled } from "@/lib/brain/guard";
import { retain } from "@/lib/brain/retain";
import { getDb } from "@/lib/db/client";
import { isRunTerminalEventKind } from "@/lib/domain-events/taxonomy";

// Project Brain (ADR-122) harvest consumer. Rides the domain_events dispatcher
// (startFrom "now", idempotent). Predicate = RUN_TERMINAL_EVENT_KINDS +
// gate.failed — NOT run.review (an orchestrator child-settled signal with a
// different payload that duplicates the child's eventual terminal). Guarded by
// projects.brain_enabled. Failure semantics (the dispatcher is at-least-once and
// does NOT advance the cursor on a throw):
//   - transient (EMBEDDING_UNAVAILABLE, network, CONFIG distill-unset) → THROW
//     so the cursor holds and the window redelivers (no event ever lost);
//   - permanent (schema-invalid distill output after one in-process retry →
//     distill returns null) → log + SKIP (advance) so there is no poison loop.

const log = pino({
  name: "brain:memory-harvest",
  level: process.env.LOG_LEVEL ?? "info",
});

type HarvestTx = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type HarvestDb = HarvestTx & {
  transaction<T>(fn: (tx: HarvestTx) => Promise<T>): Promise<T>;
};

export function isHarvestable(kind: string): boolean {
  // NOTE: run.review is deliberately excluded (an orchestrator child-settled
  // signal whose payload duplicates the child's eventual terminal event).
  // run.escalated is also excluded FOR NOW: the run has not concluded yet — its
  // lesson arrives with the terminal event; harvesting both would double-distill
  // one story. Revisit if escalations prove to carry distinct signal.
  return isRunTerminalEventKind(kind) || kind === "gate.failed";
}

async function alreadyHarvested(
  db: HarvestDb,
  projectId: string,
  eventId: number,
): Promise<boolean> {
  // The harvested-events ledger (F4) records EVERY processed event regardless of
  // the retain outcome, so it catches redelivery of a reinforce/exact-dup event
  // (which leaves no brain_items.source_domain_event_id row). This is the cheap
  // pre-distill short-circuit; retain's in-tx claim is the atomic backstop.
  const r = await db.execute(
    sql`SELECT 1 FROM brain_harvested_events
        WHERE project_id = ${projectId} AND domain_event_id = ${eventId}
        LIMIT 1`,
  );

  return r.rows.length > 0;
}

export interface HarvestOpts {
  db: HarvestDb;
  // Lazy so a batch of only brain-disabled events never touches the provider.
  resolveClient: () => Promise<OpenAiCompatibleClient>;
}

// The harvest core, injectable for tests. A throw propagates to the dispatcher
// (cursor holds); a normal return advances the cursor.
export async function harvestEvents(
  events: DomainEventRow[],
  opts: HarvestOpts,
): Promise<void> {
  const { db } = opts;
  let client: OpenAiCompatibleClient | null = null;

  for (const event of events) {
    if (!isHarvestable(event.kind)) continue;

    if (!(await isProjectBrainEnabled(db, event.projectId))) {
      // Intentional non-consumption — advance past it.
      continue;
    }

    if (await alreadyHarvested(db, event.projectId, event.id)) continue;

    // Resolve once per batch, lazily. A cleared config throws CONFIG here →
    // transient → the cursor holds (unreachable in steady state given the
    // enable-gate).
    if (!client) client = await opts.resolveClient();

    const payload = (event.payload ?? {}) as Record<string, unknown>;

    // distill throws on transient failure (EMBEDDING_UNAVAILABLE / CONFIG
    // distill-unset) → propagate; returns null on schema-invalid → skip.
    const lesson = await distill(
      {
        kind: event.kind,
        projectId: event.projectId,
        runId: event.runId,
        taskId: event.taskId,
        payload,
      },
      { db, client },
    );

    if (!lesson) {
      log.warn(
        { eventId: event.id, kind: event.kind, projectId: event.projectId },
        "[brain.harvest] distill produced no valid lesson — skipping",
      );
      continue;
    }

    // retain embeds (may throw EMBEDDING_UNAVAILABLE → transient → propagate).
    await retain(
      event.projectId,
      { kind: lesson.kind, content: lesson.content, tags: lesson.tags },
      {
        sourceRunId: event.runId,
        sourceNodeAttemptId:
          (payload.nodeAttemptId as string | undefined) ?? null,
        sourceDomainEventId: event.id,
        sourceGateKind: (payload.gateKind as string | undefined) ?? null,
      },
      { db, client },
    );
  }
}

export const memoryHarvestConsumer: DomainEventConsumer = {
  id: "memory_harvest",
  startFrom: "now",
  async handle(events: DomainEventRow[]): Promise<void> {
    // SQLite → the Brain is disabled (D3); harvest is a no-op that advances.
    if (!isBrainProvisioned()) return;

    const db = getDb() as unknown as HarvestDb;

    await harvestEvents(events, {
      db,
      resolveClient: () =>
        getBrainEmbeddingClient(
          db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
        ),
    });
  },
};
