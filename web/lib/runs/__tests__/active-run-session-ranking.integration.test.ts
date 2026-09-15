// A run's ACTIVE session is ranked live-first, and "live" means a non-terminal
// incarnation — NOT `acp_session_id IS NOT NULL`. That column is the
// `session/resume` checkpoint handle: it deliberately outlives the process and
// nothing clears it when an incarnation ends, so ranking on it alone let a
// FINISHED substep session (a consensus verification, a gate evaluation)
// outrank the node's own — it keeps its handle and carries a newer
// `updated_at`, which only the create ack bumps.
//
// Real Postgres because the ranking IS the SQL (a correlated EXISTS over
// `run_session_incarnations`); a stubbed db proves nothing about it.

import type { AdapterId } from "@/lib/acp-runners/adapter-support";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runSessionIncarnations, runSessions, runs } from "@/lib/db/schema";
import {
  activeSessionCapabilityAgent,
  loadActiveRunSession,
  loadActiveRunSessionsByRunId,
} from "@/lib/runs/active-run-session";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: NodePgDatabase;
let runId: string;
let hostId: string;
let projectId: string;

async function seedSession(input: {
  runId: string;
  sessionName: string;
  capabilityAgent: AdapterId;
  acpSessionId: string | null;
  state: "created" | "active" | "checkpointed" | "exited" | "crashed" | null;
  boundAt: Date;
}): Promise<string> {
  const id = randomUUID();

  await db.insert(runSessions).values({
    id,
    runId: input.runId,
    sessionName: input.sessionName,
    capabilityAgent: input.capabilityAgent,
    runnerSnapshot: { capabilityAgent: input.capabilityAgent } as never,
    acpSessionId: input.acpSessionId,
    createdAt: input.boundAt,
    updatedAt: input.boundAt,
  });

  if (input.state !== null) {
    await db.insert(runSessionIncarnations).values({
      id: randomUUID(),
      runSessionId: id,
      runId: input.runId,
      executionHostId: hostId,
      hostSessionId: randomUUID(),
      state: input.state,
      origin: "native",
    });
  }

  return id;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "active_session_ranking",
  });
  db = database.db;
  projectId = await seedProject(db);

  runId = await seedRun(db, { projectId });
  hostId = (await seedLocalHost(db)).id;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("active run session ranking", () => {
  it("a finished substep does not outrank the node's checkpointed session", async () => {
    // The node bound first and is parked at an idle checkpoint; the verifier
    // bound later, finished, and kept its resume handle.
    await seedSession({
      runId,
      sessionName: "default",
      capabilityAgent: "claude",
      acpSessionId: "acp-node",
      state: "checkpointed",
      boundAt: new Date(Date.now() - 10 * 60_000),
    });
    await seedSession({
      runId,
      sessionName: "plan_consensus-verify-1-0",
      capabilityAgent: "codex",
      acpSessionId: "acp-verify",
      state: "exited",
      boundAt: new Date(Date.now() - 60_000),
    });

    const active = await loadActiveRunSession(db, runId);

    expect(active?.sessionName).toBe("default");
    // The checkpointed handle is what idle resume replays — never the dead
    // verifier's.
    expect(active?.acpSessionId).toBe("acp-node");

    const batch = await loadActiveRunSessionsByRunId(db, [runId]);

    expect(batch.get(runId)?.sessionName).toBe("default");

    // The correlated-scalar form used by the portfolio/board/run/inbox selects
    // must agree with the loader, or a card shows a different runner than the
    // page acting on it.
    const [row] = await db
      .select({ agent: activeSessionCapabilityAgent(runs.id) })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(row?.agent).toBe("claude");
  });

  it("a LIVE substep does outrank the node — it is what a permission HITL is blocked on", async () => {
    // A gate raising a permission is genuinely the session to resume, so
    // liveness must still win on recency within the live class.
    await seedSession({
      runId,
      sessionName: "gate-review",
      capabilityAgent: "gemini",
      acpSessionId: "acp-gate",
      state: "active",
      boundAt: new Date(),
    });

    const active = await loadActiveRunSession(db, runId);

    expect(active?.sessionName).toBe("gate-review");
  });

  // Liveness is the FIRST key, so a session whose incarnation is live but which
  // has not been prompted yet carries no resume handle. It must not displace a
  // checkpointed session that has one, or `resumeRun` would read a null
  // `acpSessionId` and fail the run terminally. That is what the second key is
  // for — the handle breaks ties WITHIN the live class.
  it("among live sessions the one holding a resume handle still wins", async () => {
    const otherRunId = await seedRun(db, { projectId });

    await seedSession({
      runId: otherRunId,
      sessionName: "default",
      capabilityAgent: "claude",
      acpSessionId: "acp-node",
      state: "checkpointed",
      boundAt: new Date(Date.now() - 10 * 60_000),
    });
    await seedSession({
      runId: otherRunId,
      sessionName: "gate-fresh",
      capabilityAgent: "codex",
      acpSessionId: null,
      state: "created",
      boundAt: new Date(),
    });

    const active = await loadActiveRunSession(db, otherRunId);

    expect(active?.sessionName).toBe("default");
    expect(active?.acpSessionId).toBe("acp-node");
  });
});
