import "server-only";

import type {
  DomainEventKind,
  RunTerminalEventKind,
} from "@/lib/domain-events/taxonomy";

import pino from "pino";

import { domainEvents } from "@/lib/db/schema";

const log = pino({
  name: "domain-events-outbox",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants — accepts both a plain db and
// a tx handle so the capture rides the caller's transaction (matches the
// web/lib/webhooks/outbox.ts idiom).
type Db = any;

// Shape-compatible with SocialActor (web/lib/social/activity.ts) so task-domain
// call sites pass their actor through unchanged.
export interface DomainEventActor {
  type: "user" | "system" | "agent";
  id: string | null;
}

interface BaseDomainEventInput {
  db: Db;
  projectId: string;
  taskId?: string | null;
  runId?: string | null;
  actor?: DomainEventActor | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

// M36 (ADR-095): a discriminated union on `kind`. Run-terminal events MUST carry
// `parentRunId` (null for a top-level run) — the compiler refuses a run-terminal
// emit that omits it, so a new terminal path cannot silently drop the routing
// key the orchestrator auto-launcher + resume consumer depend on. Other kinds
// forbid the field.
export type EmitDomainEventInput =
  | (BaseDomainEventInput & {
      kind: RunTerminalEventKind;
      parentRunId: string | null;
    })
  | (BaseDomainEventInput & {
      kind: Exclude<DomainEventKind, RunTerminalEventKind>;
      parentRunId?: never;
    });

// A plain INSERT with no RETURNING — the id is identity-generated and nothing
// on the write path needs it (dispatch reads by PK range later). Keeping the
// statement minimal also matches the webhook-outbox idiom and the db stubs the
// unit suites drive these transitions with.
export async function emitDomainEvent(
  input: EmitDomainEventInput,
): Promise<void> {
  // Run-terminal kinds fold parent_run_id into the payload (null for top-level).
  const payload =
    input.parentRunId === undefined
      ? input.payload
      : { ...input.payload, parentRunId: input.parentRunId };

  await input.db.insert(domainEvents).values({
    kind: input.kind,
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    actorType: input.actor?.type ?? null,
    actorId: input.actor?.id ?? null,
    payload,
    occurredAt: input.occurredAt ?? new Date(),
  });

  log.debug(
    {
      kind: input.kind,
      projectId: input.projectId,
      taskId: input.taskId ?? undefined,
      runId: input.runId ?? undefined,
    },
    "[domain-events.emit] emitted",
  );
}
