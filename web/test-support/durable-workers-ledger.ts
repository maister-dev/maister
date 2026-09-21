import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, eq } from "drizzle-orm";

import * as fullSchema from "@/lib/db/schema";

// Watching the command ledger, shared by both durable-worker production-boot
// suites.
//
// The kill window opens at ADMISSION, not when a launch call returns. The
// scratch launch drains an SSE stream that can outlive the turn it started, so
// a test gated on the launch response can find the turn already applied and
// then assert "exactly one application" against a race it never ran. Watching
// the ledger by owner kind instead makes every domain race the same way, and
// the run id comes back off the command row.

const schema = fullSchema as unknown as Record<string, any>;

export type OwnerKind =
  | "flow_node_attempt"
  | "agent_turn"
  | "scratch_message"
  | "gate_chat"
  | "sync_resolution";

export type PromptCommandRow = {
  id: string;
  runId: string;
  state: string;
  applicationState: string;
  completionAppliedAt: Date | null;
  terminalEvidenceSha256: string | null;
  applicationClaimOwner: string | null;
  ownerKind: string | null;
};

const promptColumns = () => ({
  id: schema.executionCommands.id,
  runId: schema.executionCommands.runId,
  state: schema.executionCommands.state,
  applicationState: schema.executionCommands.applicationState,
  completionAppliedAt: schema.executionCommands.completionAppliedAt,
  terminalEvidenceSha256: schema.executionCommands.terminalEvidenceSha256,
  applicationClaimOwner: schema.executionCommands.applicationClaimOwner,
  ownerKind: schema.executionCommands.ownerKind,
});

export async function poll<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs: number,
  what: string,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;

  while (Date.now() < deadline) {
    const value = await read();

    if (value !== null && value !== undefined) return value;
    last = value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${what} (last: ${JSON.stringify(last)})`,
  );
}

export async function promptCommandsForRun(
  db: NodePgDatabase,
  runId: string,
): Promise<PromptCommandRow[]> {
  return db
    .select(promptColumns())
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.prompt"),
      ),
    ) as Promise<PromptCommandRow[]>;
}

export async function promptCommandsForKind(
  db: NodePgDatabase,
  ownerKind: OwnerKind,
): Promise<PromptCommandRow[]> {
  return db
    .select(promptColumns())
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.kind, "session.prompt"),
        eq(schema.executionCommands.ownerKind, ownerKind),
      ),
    ) as Promise<PromptCommandRow[]>;
}

export async function promptIdsForKind(
  db: NodePgDatabase,
  ownerKind: OwnerKind,
): Promise<Set<string>> {
  const rows = await promptCommandsForKind(db, ownerKind);

  return new Set(rows.map((row) => row.id));
}

/** The first owned prompt of this kind that was not already in the ledger. */
export async function awaitOwnedPrompt(
  db: NodePgDatabase,
  ownerKind: OwnerKind,
  seenBefore: ReadonlySet<string>,
  // Admission itself is what starves in the parallel lane — the flow row landed
  // in 33 s there while the agent and scratch rows exceeded 120 s. The budget is
  // the lane's, not an idle host's.
  timeoutMs = 360_000,
): Promise<PromptCommandRow> {
  return poll(
    async () =>
      (await promptCommandsForKind(db, ownerKind)).find(
        (row) => !seenBefore.has(row.id),
      ) ?? null,
    timeoutMs,
    `an owned ${ownerKind} session.prompt command to be admitted`,
    250,
  );
}
