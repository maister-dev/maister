import "server-only";

import type {
  DomainEventKind,
  RunSettledEventKind,
  TerminalCause,
  TerminalFailureEventKind,
} from "@/lib/domain-events/taxonomy";
import type { SQL } from "drizzle-orm";
import type { Owner } from "@/lib/company/types";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { SpecialistAssignmentStatus } from "@/lib/specialist-assignments/types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { domainEvents } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { terminalCauseReason } from "@/lib/domain-events/taxonomy";
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

/** Retain assignment transitions on the existing transactional bus without publishing request content. */
export async function emitSpecialistAssignmentChange(
  input: Readonly<{
    db: SqlTransaction;
    owner: Owner;
    assignmentId: string;
    revision: number;
    previousStatus: SpecialistAssignmentStatus | null;
    status: SpecialistAssignmentStatus;
    cause:
      | "created"
      | "input"
      | "context"
      | "work"
      | "question"
      | "continuation_ready"
      | "acceptance"
      | "cancelled"
      | "ownership"
      | "state"
      | "recovered";
    actor: DomainEventActor;
  }>,
): Promise<void> {
  const payload = {
    owner: input.owner,
    assignmentId: input.assignmentId,
    revision: input.revision,
    previousStatus: input.previousStatus,
    status: input.status,
    cause: input.cause,
  };

  await input.db.execute(
    sql`INSERT INTO domain_events(kind,project_id,company_id,actor_type,actor_id,payload,occurred_at) VALUES('specialist.assignment_changed',${input.owner.kind === "project" ? input.owner.projectId : null},${input.owner.kind === "company" ? input.owner.companyId : null},${input.actor.type},${input.actor.id},${JSON.stringify(payload)}::jsonb,clock_timestamp())`,
  );
  log.debug(
    {
      kind: "specialist.assignment_changed",
      ownerKind: input.owner.kind,
      assignmentId: input.assignmentId,
      revision: input.revision,
      status: input.status,
      cause: input.cause,
    },
    "specialist assignment change emitted",
  );
}

/** Native publication uses the same committed outbox and dispatcher as project work. */
export async function emitKnowledgeRecordChange(
  input: Readonly<{
    db: { execute(query: SQL): Promise<unknown> };
    owner: Owner;
    recordId: string;
    revision: number;
    changeId: string;
    cause: "published" | "confirmed" | "revoked" | "retired";
    actor: DomainEventActor;
  }>,
): Promise<void> {
  const payload = {
    owner: input.owner,
    recordId: input.recordId,
    revision: input.revision,
    changeId: input.changeId,
    cause: input.cause,
  };

  await input.db.execute(
    sql`INSERT INTO domain_events(kind,project_id,company_id,actor_type,actor_id,payload,occurred_at) VALUES('knowledge.record_changed',${input.owner.kind === "project" ? input.owner.projectId : null},${input.owner.kind === "company" ? input.owner.companyId : null},${input.actor.type},${input.actor.id},${JSON.stringify(payload)}::jsonb,clock_timestamp())`,
  );
  log.debug(
    {
      kind: "knowledge.record_changed",
      ownerKind: input.owner.kind,
      recordId: input.recordId,
      revision: input.revision,
      changeId: input.changeId,
    },
    "knowledge change emitted",
  );
}

export type RunDomainEventScope =
  | { projectId: string; companyId?: never }
  | { companyId: string; projectId?: never };

/** Resolve only an explicit retained owner; project-less runs are not implicitly company work. */
export function runDomainEventScope(
  run: Readonly<{ projectId: string | null; companyId: string | null }>,
): RunDomainEventScope {
  if (run.projectId !== null && run.companyId === null)
    return { projectId: run.projectId };
  if (run.companyId !== null && run.projectId === null)
    return { companyId: run.companyId };

  throw new MaisterError(
    "PRECONDITION",
    "Run domain events require exactly one retained project or company owner",
  );
}

type BaseDomainEventInput = RunDomainEventScope & {
  db: Db;
  taskId?: string | null;
  runId?: string | null;
  actor?: DomainEventActor | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
};

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

function tokenOnlyCause(
  cause: TerminalCause,
  kind: DomainEventKind,
  runId: string | null | undefined,
): TerminalCause {
  const reason = terminalCauseReason(cause.reason);

  if (cause.reason !== undefined && reason !== cause.reason)
    log.warn(
      { kind, runId, kept: reason ?? null },
      "terminal-cause-reason-normalized",
    );

  return {
    code: cause.code,
    ...(reason === undefined ? {} : { reason }),
    source: cause.source,
  };
}

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
  // and the failure kinds their typed cause — a reason only as a token (D-B1),
  // enforced here, the one write every terminal emitter goes through.
  const payload = {
    ...input.payload,
    ...(input.parentRunId === undefined
      ? {}
      : { parentRunId: input.parentRunId }),
    ...(input.cause === undefined
      ? {}
      : { cause: tokenOnlyCause(input.cause, input.kind, input.runId) }),
  };

  await input.db.insert(domainEvents).values({
    kind: input.kind,
    projectId: input.projectId ?? null,
    ...(input.companyId === undefined ? {} : { companyId: input.companyId }),
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
      companyId: input.companyId,
      taskId: input.taskId ?? undefined,
      runId: input.runId ?? undefined,
    },
    "[domain-events.emit] emitted",
  );
}
