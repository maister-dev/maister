import "server-only";

import { sessionNameForPackageNode } from "@/lib/capabilities/package-delivery";
import { and, desc, eq, exists } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { nodeAttempts, runSessions, runSessionIncarnations, runs } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "node-resume-session",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-175 Scope 3. The resume handle of the RECOVER-TARGET NODE, resolved from
// that node's own ledger row and falling back to its logical session.
//
// Deliberately NOT `loadActiveRunSession`: its first ranking key is liveness,
// and after a crash every incarnation is terminal, so the key ties false for
// every row and `updated_at` decides. `run_sessions.updated_at` is bumped only
// by the create ack, and a substep (`gate-<id>`, `<node>-verify-<n>-<k>`) is
// always bound LATER than the node it runs beside — so for a crashed run the
// substep outranks the node reliably, not occasionally. Resuming a finished
// gate's context in the node's place is silent and unrecoverable.
//
// Shared by every recover reader — the Phase-1 classifier, the Phase-2 drive,
// the scheduler's queued promotion and the UI recoverability projection — so
// the affordance can never disagree with what the route will actually do.
export async function resolveNodeResumeSessionId(
  db: Db,
  input: { runId: string; nodeId: string | null; sessionName: string },
): Promise<string | null> {
  if (!input.nodeId) return null;

  const attemptRows = await db
    .select({ id: nodeAttempts.id, acpSessionId: nodeAttempts.acpSessionId })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.nodeId, input.nodeId),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt))
    .limit(1);

  if (attemptRows[0]?.acpSessionId) {
    log.debug(
      { runId: input.runId, nodeId: input.nodeId, source: "node_attempt" },
      "crash-recover: resolved the node's resume handle",
    );

    return attemptRows[0].acpSessionId as string;
  }

  const [run] = await db
    .select({ snapshot: runs.resolvedCapabilitySet })
    .from(runs)
    .where(eq(runs.id, input.runId))
    .limit(1);
  const name = sessionNameForPackageNode(
    run?.snapshot?.delivery,
    input.nodeId,
    input.sessionName,
  );
  const isolated =
    run?.snapshot?.delivery?.bindings?.[input.nodeId]?.mode === "session";
  if (isolated && !attemptRows[0]) return null;
  const sessionRows = await db
    .select({ acpSessionId: runSessions.acpSessionId })
    .from(runSessions)
    .where(
      and(
        eq(runSessions.runId, input.runId),
        eq(runSessions.sessionName, name),
        isolated
          ? exists(
              db
                .select({ id: runSessionIncarnations.id })
                .from(runSessionIncarnations)
                .where(
                  and(
                    eq(runSessionIncarnations.runSessionId, runSessions.id),
                    eq(runSessionIncarnations.runId, input.runId),
                    eq(
                      runSessionIncarnations.contextNodeAttemptId,
                      attemptRows[0].id,
                    ),
                    eq(
                      runSessionIncarnations.acpSessionId,
                      runSessions.acpSessionId,
                    ),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .limit(1);

  log.debug(
    {
      runId: input.runId,
      nodeId: input.nodeId,
      sessionName: input.sessionName,
      source: "logical_session",
      resolved: Boolean(sessionRows[0]?.acpSessionId),
    },
    "crash-recover: resolved the node's resume handle",
  );

  return (sessionRows[0]?.acpSessionId as string | null) ?? null;
}
