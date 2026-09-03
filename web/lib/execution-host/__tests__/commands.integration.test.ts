// ADR-166 T1.2 — execution_commands ledger (C1–C5).

import type { Db } from "@/lib/execution-host/db";

import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import {
  claimDelivering,
  failRetryable,
  insertCommand,
  loadOpenCommands,
  markAccepted,
  markFenced,
  markSucceeded,
} from "@/lib/execution-host/commands";
import {
  seedLocalHost,
  seedProject,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let hostId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eh_commands_test",
  });
  db = testDatabase.db as unknown as Db;
  projectId = await seedProject(testDatabase.db);
  hostId = (await seedLocalHost(testDatabase.db)).id;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedAssignment() {
  const runId = await seedRun(testDatabase.db, { projectId });
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx as unknown as Db, { runId, hostId, reason: "launch" }),
  );

  return { runId, assignment };
}

async function readCommand(id: string) {
  const rows = (await db
    .select()
    .from(schema.executionCommands)
    .where(eq(schema.executionCommands.id, id))) as unknown as Array<{
    state: string;
    attempts: number;
    payload: Record<string, unknown>;
    completedAt: Date | null;
    acceptedAt: Date | null;
    nextAttemptAt: Date | null;
    result: Record<string, unknown> | null;
    lastError: Record<string, unknown> | null;
  }>;

  return rows[0];
}

const SENTINEL_TOKEN = "sk-live-SENTINEL-1234567890";
const SENTINEL_PROMPT = "PROMPT-BODY-SENTINEL do the thing";

describe("insertCommand", () => {
  it("C1: inserts queued with a redacted payload (no secret values, no prompt body)", async () => {
    const { runId, assignment } = await seedAssignment();

    const row = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.create",
      maxAttempts: 3,
      payload: {
        executionWorkspaceId: "ws_" + "b".repeat(32),
        stepId: "plan",
        prompt: SENTINEL_PROMPT,
        contentBlocks: [{ type: "text", text: SENTINEL_PROMPT }],
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { ANTHROPIC_AUTH_TOKEN: SENTINEL_TOKEN },
        },
        runner: {
          sidecar: { authTokenEnv: "MAISTER_CCR_AUTH_TOKEN" },
          apiKey: SENTINEL_TOKEN,
        },
        adapterLaunch: { env: { MAISTER_CAPABILITY_PROFILE: "/p" } },
      },
    });

    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.completedAt).toBeNull();

    const persisted = await readCommand(row.id);
    const json = JSON.stringify(persisted.payload);

    expect(json).not.toContain(SENTINEL_TOKEN);
    expect(json).not.toContain(SENTINEL_PROMPT);
    expect(persisted.payload).not.toHaveProperty("prompt");
    expect(persisted.payload.promptBytes).toBe(
      Buffer.byteLength(SENTINEL_PROMPT, "utf8"),
    );
    expect(persisted.payload.contentBlockCount).toBe(1);
    // Ids survive redaction — the ledger row stays explainable.
    expect(persisted.payload.stepId).toBe("plan");
    expect(persisted.payload.executionWorkspaceId).toBe("ws_" + "b".repeat(32));
    expect((persisted.payload.executor as { model: string }).model).toBe(
      "claude-sonnet-4-6",
    );
    // Env keys survive, values do not.
    expect(
      (persisted.payload.executor as { env: Record<string, string> }).env,
    ).toEqual({ ANTHROPIC_AUTH_TOKEN: "[REDACTED]" });
  });
});

describe("CAS transitions", () => {
  it("C2: queued→delivering→succeeded with the attempts predicate; a stale attempt number is ignored", async () => {
    const { runId, assignment } = await seedAssignment();
    const row = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.checkpoint",
      maxAttempts: 3,
      payload: {},
    });

    const claimed = await claimDelivering(db, row.id, 0);

    expect(claimed.changed).toBe(true);
    expect(claimed.row?.state).toBe("delivering");
    expect(claimed.row?.attempts).toBe(1);
    expect(claimed.row?.deliveringSince).not.toBeNull();

    // A stale ack (attempt 0) after the claim bumped attempts to 1.
    const stale = await markSucceeded(db, row.id, 0, { ok: true });

    expect(stale.changed).toBe(false);
    expect((await readCommand(row.id)).state).toBe("delivering");

    const acked = await markSucceeded(db, row.id, 1, {
      alreadyCheckpointed: false,
    });

    expect(acked.changed).toBe(true);

    const final = await readCommand(row.id);

    expect(final.state).toBe("succeeded");
    expect(final.completedAt).not.toBeNull();
    expect(final.result).toEqual({ alreadyCheckpointed: false });
  });

  it("C3: a signal on a terminal row changes nothing and logs command-late-signal", async () => {
    const { runId, assignment } = await seedAssignment();
    const row = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      maxAttempts: 3,
      payload: { stepId: "plan", prompt: "x" },
    });

    await claimDelivering(db, row.id, 0);
    await markAccepted(db, row.id, 1);
    await markSucceeded(db, row.id, 1, { stopReason: "end_turn" });

    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");

    const late = await markFenced(
      db,
      row.id,
      null,
      { code: "FENCED" },
      { logger },
    );

    expect(late.changed).toBe(false);
    expect(late.row?.state).toBe("succeeded");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe("command-late-signal");
    expect((warn.mock.calls[0][0] as { terminal: boolean }).terminal).toBe(
      true,
    );

    const persisted = await readCommand(row.id);

    expect(persisted.state).toBe("succeeded");
    expect(persisted.result).toEqual({ stopReason: "end_turn" });
    expect(persisted.lastError).toBeNull();
  });

  it("C4: failRetryable re-queues with next_attempt_at while attempts < max, then fails", async () => {
    const { runId, assignment } = await seedAssignment();
    const row = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.input",
      maxAttempts: 2,
      payload: { action: "select", requestId: "r1", optionId: "allow" },
    });
    const later = new Date(Date.now() + 5_000);

    await claimDelivering(db, row.id, 0);
    const first = await failRetryable(
      db,
      row.id,
      1,
      { code: "ECONNREFUSED" },
      { nextAttemptAt: later },
    );

    expect(first.exhausted).toBe(false);
    expect(first.row?.state).toBe("queued");
    expect(first.row?.nextAttemptAt?.getTime()).toBe(later.getTime());
    expect(first.row?.deliveringSince).toBeNull();
    expect(first.row?.lastError).toEqual({ code: "ECONNREFUSED" });

    await claimDelivering(db, row.id, 1);
    const second = await failRetryable(
      db,
      row.id,
      2,
      { code: "ECONNREFUSED" },
      { nextAttemptAt: later },
    );

    expect(second.exhausted).toBe(true);
    expect(second.row?.state).toBe("failed");
    expect(second.row?.completedAt).not.toBeNull();
    expect((await readCommand(row.id)).attempts).toBe(2);
  });

  it("C5: loadOpenCommands returns only queued|delivering|accepted", async () => {
    const { runId, assignment } = await seedAssignment();
    const mk = (kind: "session.cancel" | "session.delete") =>
      insertCommand(db, {
        runId,
        assignmentId: assignment.id,
        hostId,
        assignmentEpoch: assignment.epoch,
        kind,
        maxAttempts: 3,
        payload: {},
      });
    const queued = await mk("session.cancel");
    const delivering = await mk("session.cancel");
    const accepted = await mk("session.cancel");
    const succeeded = await mk("session.delete");
    const fenced = await mk("session.delete");

    await claimDelivering(db, delivering.id, 0);
    await claimDelivering(db, accepted.id, 0);
    await markAccepted(db, accepted.id, 1);
    await claimDelivering(db, succeeded.id, 0);
    await markSucceeded(db, succeeded.id, 1, null);
    await markFenced(db, fenced.id, null, { code: "FENCED" });

    const open = (await loadOpenCommands(db)).filter((c) => c.runId === runId);
    const ids = new Set(open.map((c) => c.id));

    expect(ids.has(queued.id)).toBe(true);
    expect(ids.has(delivering.id)).toBe(true);
    expect(ids.has(accepted.id)).toBe(true);
    expect(ids.has(succeeded.id)).toBe(false);
    expect(ids.has(fenced.id)).toBe(false);
    expect(open.map((c) => c.state).sort()).toEqual([
      "accepted",
      "delivering",
      "queued",
    ]);
  });
});
