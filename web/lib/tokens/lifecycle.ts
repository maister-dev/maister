import "server-only";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { tokenLifecycleEvents } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// ADR-168. TWO distinct rules share this one pattern, and conflating them is a
// bug in both directions:
//   1. `isManagedToken` — refuses to EDIT a row that already carries such a
//      name (it is a live run-bound credential).
//   2. `assertTokenNameAllowed` — refuses to SET such a name on a
//      human-issued token (the name is the run-binding authorization subject
//      that `parseBoundRunId` derives).
// Spelling the pattern twice is how the two halves drift apart.
//
// The prefix LIST is shared with `parseBoundRunId` in verify.ts, which derives
// the run-binding authorization subject from the same names. A new run-bound
// prefix added there without being added here leaves that credential class
// editable and forgeable — keep the two in sync.
export const RESERVED_TOKEN_NAME_PATTERN = /^(orchestrator-run|agent-run):/i;

export type TokenLifecycleEventName =
  | "issued"
  | "scopes_changed"
  | "renamed"
  | "expiry_changed"
  | "revoked";

export type TokenLifecycleActor = {
  userId: string | null;
  // Durable attribution: survives actor_user_id being nulled by a user delete.
  label: string;
};

export type ManagedTokenRow = {
  token_kind?: string | null;
  name?: string | null;
};

/**
 * A MANAGED token is a durable, human-issued credential: the rows the token
 * management UIs create and list. A NON-managed token is machine-minted and
 * run-bound, revoked by its own lifecycle.
 *
 * The kind alone is not enough: `issueOrchestratorRunToken` inserts
 * `token_kind='project'` named `orchestrator-run:<runId>` (ADR-098), so a
 * kind-only check would admit a live orchestrator credential.
 *
 * One predicate, two consumers — editability and ledger membership.
 */
export function isManagedToken(row: ManagedTokenRow): boolean {
  const kind = row.token_kind ?? "project";

  return kind !== "agent" && !RESERVED_TOKEN_NAME_PATTERN.test(row.name ?? "");
}

/**
 * Refuse a reserved run-bound name on any human-issuance or edit path.
 *
 * Route/service layer only, NEVER a table CHECK: `issueOrchestratorRunToken`
 * and `issueAgentRunToken` legitimately write exactly these names, and a
 * constraint would break agent launches.
 */
export function assertTokenNameAllowed(name: string): void {
  // Tested against the TRIMMED name: the project POST schema is
  // `z.string().min(1)` with no `.trim()`, so " orchestrator-run:<id>" would
  // otherwise slip past this anchored pattern. It is inert today only because
  // `parseBoundRunId` is anchored identically — i.e. the forgery is blocked by
  // a coincidence of two regexes rather than by this guard. Refuse it here so
  // the guard stands on its own.
  if (RESERVED_TOKEN_NAME_PATTERN.test(name.trim())) {
    throw new MaisterError(
      "CONFIG",
      "token name must not start with a reserved run-bound prefix " +
        "(orchestrator-run: or agent-run:)",
      { details: { field: "name" } },
    );
  }
}

/**
 * The ONLY writer of `token_lifecycle_events`. It refuses non-managed tokens
 * itself so no call site can forget the rule (D11). Returns whether a row was
 * written.
 *
 * Callers MUST pass the same `db` as the surrounding transaction so the ledger
 * row commits with the write that caused it.
 */
export async function recordTokenLifecycleEvent(
  input: {
    token: ManagedTokenRow & { id: string; project_id?: string | null };
    event: TokenLifecycleEventName;
    actor: TokenLifecycleActor;
    before?: unknown;
    after?: unknown;
  },
  db?: Db,
): Promise<boolean> {
  if (!isManagedToken(input.token)) {
    return false;
  }

  const d = db ?? getDb();

  await d.insert(tokenLifecycleEvents).values({
    token_id: input.token.id,
    project_id: input.token.project_id ?? null,
    event: input.event,
    actor_user_id: input.actor.userId,
    actor_label: input.actor.label,
    before: input.before ?? null,
    after: input.after ?? null,
  });

  return true;
}
