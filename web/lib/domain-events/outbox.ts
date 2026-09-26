import "server-only";

import type {
  DomainEventKind,
  RunSettledEventKind,
  TerminalCause,
  TerminalFailureEventKind,
} from "@/lib/domain-events/taxonomy";

import pino from "pino";

import { domainEvents } from "@/lib/db/schema";
import { armFailedCoordinatorWake } from "@/lib/domain-events/coordinator-wake-intent";

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

// M37 (ADR-098/097): a discriminated union on `kind`. Run-SETTLED events
// (terminal kinds + `run.review`) MUST carry `parentRunId` (null for a top-level
// run) — the compiler refuses a settled emit that omits it, so a new settled
// path cannot silently drop the routing key the orchestrator auto-launcher +
// resume consumer depend on. Other kinds forbid the field.
//
// ADR-177 amendment 2026-09-26 (B6): the three failure kinds MUST carry the
// typed `cause` too — the same rule, so a new terminal writer cannot ship a
// run that ends without saying why. It is folded into the payload.
export type EmitDomainEventInput =
  | (BaseDomainEventInput & {
      kind: TerminalFailureEventKind;
      parentRunId: string | null;
      cause: TerminalCause;
    })
  | (BaseDomainEventInput & {
      kind: Exclude<RunSettledEventKind, TerminalFailureEventKind>;
      parentRunId: string | null;
      cause?: never;
    })
  | (BaseDomainEventInput & {
      kind: Exclude<DomainEventKind, RunSettledEventKind>;
      parentRunId?: never;
      cause?: never;
    });

// A plain INSERT with no RETURNING — the id is identity-generated and nothing
// on the write path needs it (dispatch reads by PK range later). Keeping the
// statement minimal also matches the webhook-outbox idiom and the db stubs the
// unit suites drive these transitions with.
export async function emitDomainEvent(
  input: EmitDomainEventInput,
): Promise<void> {
  if (
    input.parentRunId &&
    (input.kind === "run.failed" ||
      input.kind === "run.crashed" ||
      input.kind === "run.abandoned")
  ) {
    // The child status, event and wake intent share the caller's transaction.
    // A consumer replay cannot re-arm an already handled failure.
    if (await armFailedCoordinatorWake(input.db, input.parentRunId))
      log.info(
        {
          parentRunId: input.parentRunId,
          childRunId: input.runId,
          kind: input.kind,
        },
        "[FIX:P0-5] failed child armed coordinator wake",
      );
  }

  // Run-terminal kinds fold parent_run_id into the payload (null for top-level),
  // and the failure kinds their typed cause.
  const payload = {
    ...input.payload,
    ...(input.parentRunId === undefined
      ? {}
      : { parentRunId: input.parentRunId }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  };

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
