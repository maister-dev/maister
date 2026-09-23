// ADR-167 D5 amendment (2026-09-23) — B.5 edges that need the fake host's
// hooks: ingest held (the manager lags the host), a pruned span, and a
// tampered canonical event after host-span settlement. Real Postgres; the
// span route itself is proven against the real supervisor elsewhere
// (`runtime-event-span`, `host-parity`, `prompt-host-span`).
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { BoundClient } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";
import type { RuntimeEventEnvelope } from "@/lib/execution-host/runtime-events";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  executionCommands,
  executionEvents,
  nodeAttempts,
  runMessages,
  runs,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { findAgentPromptHalt } from "@/lib/execution-host/agent-pause-source";
import { reanchorDispatchedPrompts } from "@/lib/execution-host/events/run-message-store";
import { permissionCheckpointOrder } from "@/lib/execution-host/permission-handoff-evidence";
import { reduceHostSpanEvidence } from "@/lib/execution-host/prompt-evidence";
import { verifyHostPromptSpan } from "@/lib/execution-host/prompt-output";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerDeferred,
} from "@/lib/execution-host/prompt-owners";
import { reconcilePromptCommand } from "@/lib/execution-host/prompt-reconciliation";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import {
  seedLocalHost,
  seedProject,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";

let database: StartedPostgresTestDb;
let db: Db;
let projectId: string;
let fake: FakeExecutionHost;

const CREATE_PAYLOAD = {
  stepId: "s1",
  executor: { agent: "claude" as const, model: "mock" },
};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "eh_prompt_host_span_fake",
  });
  db = database.db as unknown as Db;
  projectId = await seedProject(database.db);
  fake = createFakeExecutionHost();
  await seedLocalHost(database.db, {
    hostKey: fake.identity.hostKey,
    bootId: fake.identity.bootId,
  });
}, 180_000);

beforeEach(async () => {
  resetResolverForTests();
  resetRegistrarStateForTests();
  await fake.releaseIngest();
  fake.setPrunedFloor(null);
  fake.setPromptBehavior(async () => ({ stopReason: "end_turn", meta: null }));
});

afterAll(async () => {
  await fake?.releaseIngest();
  await database?.stop();
});

/** A run whose stream already exists on the manager, then a lagging ingest. */
async function laggingSession(): Promise<{
  runId: string;
  client: BoundClient;
  hostSessionId: string;
}> {
  const runId = await seedRun(database.db, {
    projectId,
    status: "Running",
    runKind: "flow",
    executionDataPlaneMode: "canonical_events_v1",
  });

  await seedWorkspace(database.db, {
    runId,
    projectId,
    worktreePath: `/tmp/eh/${runId}`,
    parentRepoPath: "/tmp/eh/repo",
  });
  const installed = await fakeExecutionHosts(db, { fake, runId });
  const client = await installed.hosts.forAssignment(installed.assignment!);
  const session = await client.createSession(CREATE_PAYLOAD);

  fake.holdIngest();

  return { runId, client, hostSessionId: session.hostSessionId };
}

async function prompt(
  client: BoundClient,
  hostSessionId: string,
  text = "hello",
) {
  return client.prompt(
    hostSessionId,
    { stepId: "s1", prompt: text },
    { admitOwner: await seedNodePromptOwner(db, client, hostSessionId) },
  );
}

async function command(id: string): Promise<ExecutionCommand> {
  const [row] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, id));

  if (!row) throw new Error(`command ${id} is gone`);

  return row;
}

/** Drive the waiter's evidence path once, with host reads allowed. */
function reconcile(commandId: string) {
  return reconcilePromptCommand({
    db,
    commandId,
    lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
  });
}

async function untilReceipt(commandId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await reconcile(commandId);

        return (await command(commandId)).receiptEvidence?.phase ?? null;
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();
}

function tamperTerminal(stopReason: string) {
  return (envelope: RuntimeEventEnvelope): RuntimeEventEnvelope => {
    const terminal = envelope.payload?.terminal as
      | { result?: Record<string, unknown> }
      | undefined;

    if (envelope.eventType !== "session.command" || !terminal?.result)
      return envelope;

    return {
      ...envelope,
      payload: {
        ...envelope.payload,
        terminal: { ...terminal, result: { ...terminal.result, stopReason } },
      },
    };
  };
}

const countingOwners = () => {
  const applied: string[] = [];

  return {
    applied,
    owners: createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "flow_node_attempt",
        async ({ command, outcome }) => {
          // The owner reads the whole verified span — here from the host,
          // since the canonical frontier is still behind the turn.
          if (outcome.state === "succeeded")
            for await (const event of outcome.events) void event;

          return {
            apply: async () => {
              applied.push(command.id);

              return "applied";
            },
          };
        },
      ),
    ]),
  };
};

describe("host-span settlement on the fake host", () => {
  it("B5: an unreadable (pruned) span keeps the command waiting, and it settles canonically once ingest catches up", async () => {
    const { client, hostSessionId } = await laggingSession();

    fake.setPrunedFloor("1000000");
    const handle = await prompt(client, hostSessionId);

    await untilReceipt(handle.commandId);
    await reconcile(handle.commandId);
    expect(await command(handle.commandId)).toMatchObject({
      terminalEvidenceSha256: null,
      settledFrom: null,
      applicationError: null,
    });
    expect(fake.callsOf("readRuntimeEventSpan").length).toBeGreaterThan(0);

    fake.setPrunedFloor(null);
    await fake.releaseIngest();
    expect(
      (
        await client.waitForPrompt(handle, {
          signal: AbortSignal.timeout(10_000),
        })
      ).stopReason,
    ).toBe("end_turn");
    expect(await command(handle.commandId)).toMatchObject({
      settledFrom: "canonical",
    });
  });

  it("B5-retry: after an unreadable span the claimed retry settles from the host once due — never sooner — and the canonical event confirms it", async () => {
    const { client, hostSessionId } = await laggingSession();

    fake.setPrunedFloor("1000000");
    const handle = await prompt(client, hostSessionId);

    await untilReceipt(handle.commandId);
    fake.setPrunedFloor(null);
    const reads = fake.callsOf("readRuntimeEventSpan").length;
    const retry = (at: number) =>
      reconcilePromptCommand({
        db,
        commandId: handle.commandId,
        lookupReceipt: (id) => fake.transport.getCommandReceipt(id),
        now: () => new Date(at),
      });

    // Waiters wake at 4 Hz; the D-B5 claim lets one read per retry window.
    await retry(Date.now());
    expect(fake.callsOf("readRuntimeEventSpan").length).toBe(reads);
    expect(await command(handle.commandId)).toMatchObject({
      terminalEvidenceSha256: null,
      settledFrom: null,
    });

    await retry(Date.now() + 6_000);
    expect(fake.callsOf("readRuntimeEventSpan").length).toBeGreaterThan(reads);
    expect(await command(handle.commandId)).toMatchObject({
      settledFrom: "host_span",
      terminalEventId: null,
      state: "succeeded",
    });

    await fake.releaseIngest();
    await expect
      .poll(async () => (await command(handle.commandId)).terminalEventId, {
        timeout: 10_000,
      })
      .not.toBeNull();
    expect(await command(handle.commandId)).toMatchObject({
      settledFrom: "host_span",
      applicationError: null,
    });
  });

  it("B-failed: a rejected turn is never read from the host span; it settles canonically", async () => {
    const { client, hostSessionId } = await laggingSession();

    fake.setPromptBehavior(async () => {
      throw new MaisterError("ACP_PROTOCOL", "fixture turn failure");
    });
    const reads = fake.callsOf("readRuntimeEventSpan").length;
    const handle = await prompt(client, hostSessionId);

    await untilReceipt(handle.commandId);
    await reconcile(handle.commandId);
    expect((await command(handle.commandId)).receiptEvidence?.phase).toBe(
      "rejected",
    );
    expect(await command(handle.commandId)).toMatchObject({
      terminalEvidenceSha256: null,
      settledFrom: null,
    });
    expect(fake.callsOf("readRuntimeEventSpan").length).toBe(reads);

    await fake.releaseIngest();
    await expect(
      client.waitForPrompt(handle, { signal: AbortSignal.timeout(10_000) }),
    ).rejects.toBeInstanceOf(MaisterError);
    expect(await command(handle.commandId)).toMatchObject({
      state: "failed",
      settledFrom: "canonical",
    });
  });

  it("B3: a canonical event that disagrees after application is a post-hoc conflict — the applied outcome stands", async () => {
    const { client, hostSessionId } = await laggingSession();
    const { owners, applied } = countingOwners();
    const handle = await prompt(client, hostSessionId);

    expect(
      (
        await client.waitForPrompt(handle, {
          owners,
          signal: AbortSignal.timeout(10_000),
        })
      ).stopReason,
    ).toBe("end_turn");
    const settled = await command(handle.commandId);

    expect(settled).toMatchObject({
      settledFrom: "host_span",
      terminalEventId: null,
      applicationState: "applied",
    });
    expect(applied).toEqual([handle.commandId]);

    await fake.releaseIngest({ tamper: tamperTerminal("max_tokens") });
    const after = await command(handle.commandId);

    expect(after).toMatchObject({
      applicationState: "applied",
      applicationError: {
        reason: "prompt_terminal_conflict",
        causeCode: "terminal_v2_agreement",
      },
      completionAppliedAt: settled.completionAppliedAt,
      terminalEvidenceSha256: settled.terminalEvidenceSha256,
      state: "succeeded",
    });
    expect(applied).toEqual([handle.commandId]);
  });

  it("B3: the same disagreement before application poisons the command (the existing rule)", async () => {
    const { client, hostSessionId } = await laggingSession();
    const handle = await prompt(client, hostSessionId);

    await client.waitForPrompt(handle, { signal: AbortSignal.timeout(10_000) });
    expect(await command(handle.commandId)).toMatchObject({
      settledFrom: "host_span",
      applicationState: "pending",
    });

    await fake.releaseIngest({ tamper: tamperTerminal("max_tokens") });
    expect(await command(handle.commandId)).toMatchObject({
      applicationState: "poisoned",
      completionAppliedAt: null,
      applicationError: { reason: "prompt_terminal_conflict" },
    });
  });

  it("B4: host-span-first then canonical leaves the same terminal row as canonical-first; only settled_from differs", async () => {
    const canonical = await laggingSession();

    await fake.releaseIngest();
    // The fake publishes a receipt just before ingesting, so an unreadable span
    // keeps this baseline on the canonical feed deterministically.
    fake.setPrunedFloor("1000000");
    const first = await prompt(canonical.client, canonical.hostSessionId);

    await canonical.client.waitForPrompt(first, {
      signal: AbortSignal.timeout(10_000),
    });
    fake.setPrunedFloor(null);
    const lagging = await laggingSession();
    const second = await prompt(lagging.client, lagging.hostSessionId);

    await lagging.client.waitForPrompt(second, {
      signal: AbortSignal.timeout(10_000),
    });
    const hostFirst = await command(second.commandId);

    await fake.releaseIngest();
    const confirmed = await command(second.commandId);
    const baseline = await command(first.commandId);
    const shape = (row: ExecutionCommand) => ({
      state: row.state,
      stopReason: row.result?.stopReason,
      lastError: row.lastError,
      boundToReceipt: row.terminalEventId === row.receiptEvidence?.eventId,
      digest: row.terminalEvidenceSha256 !== null,
      completionAppliedAt: row.completionAppliedAt,
    });

    expect(shape(confirmed)).toEqual(shape(baseline));
    expect(confirmed.terminalEvidenceSha256).toBe(
      hostFirst.terminalEvidenceSha256,
    );
    expect([baseline.settledFrom, confirmed.settledFrom]).toEqual([
      "canonical",
      "host_span",
    ]);
  });

  // The first writer parked on the row lock settles; the second must re-read
  // under that lock. Canonical-first is the order that catches a host-span
  // writer deciding from an unlocked (stale) read of the row.
  it.each(["host_span", "canonical"] as const)(
    "B4: the host-span settlement and the canonical projector racing on one row serialize on its lock and settle once (%s parked first)",
    async (first) => {
      const { client, hostSessionId } = await laggingSession();

      // Deposit the receipt without letting the waiter settle it first.
      fake.setPrunedFloor("1000000");
      const handle = await prompt(client, hostSessionId);

      await untilReceipt(handle.commandId);
      fake.setPrunedFloor(null);
      const terminal = await verifyHostPromptSpan({
        db,
        command: await command(handle.commandId),
        signal: AbortSignal.timeout(10_000),
      });

      // Everything before the turn's terminal frame is ingested first, so the
      // canonical writer that parks is the terminal settlement itself.
      await fake.releaseIngest({
        before: (envelope) =>
          envelope.eventType === "session.command" &&
          Boolean(envelope.payload?.terminal),
      });
      const holder = await database.pool.connect();
      const parked = (writers: number) =>
        expect
          .poll(
            async () =>
              (
                await database.pool.query<{ n: number }>(
                  `SELECT count(*)::int AS n FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock'`,
                )
              ).rows[0].n,
            { timeout: 10_000 },
          )
          .toBeGreaterThanOrEqual(writers);

      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT id FROM execution_commands WHERE id = $1 FOR UPDATE",
          [handle.commandId],
        );
        let hostSpan: ReturnType<typeof reduceHostSpanEvidence>;
        let canonicalFeed: Promise<void>;

        if (first === "host_span") {
          hostSpan = reduceHostSpanEvidence(db, handle.commandId, terminal);
          await parked(1);
          canonicalFeed = fake.releaseIngest();
        } else {
          canonicalFeed = fake.releaseIngest();
          await parked(1);
          hostSpan = reduceHostSpanEvidence(db, handle.commandId, terminal);
        }
        // Both writers are parked on the row lock, not merely serialized by luck.
        await parked(2);
        await holder.query("COMMIT");
        const [reduced] = await Promise.all([hostSpan, canonicalFeed]);
        const row = await command(handle.commandId);

        expect(row.terminalEvidenceSha256).not.toBeNull();
        expect(row.terminalEventId).toBe(row.receiptEvidence?.eventId);
        expect(row.applicationError).toBeNull();
        // Exactly the first parked writer settled; the other met the digest
        // under the lock and stood down.
        expect(row.settledFrom).toBe(first);
        expect(reduced.settledHere).toBe(first === "host_span");
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    },
  );

  it("B6: a released assignment's completed turn settles the historical ledger only", async () => {
    const { runId, client, hostSessionId } = await laggingSession();
    const handle = await prompt(client, hostSessionId);

    await untilReceipt(handle.commandId);
    await releaseAssignmentForRun(db, runId, "b6-checkpoint-won");
    const snapshot = async () => ({
      run: (await db.select().from(runs).where(eq(runs.id, runId)))[0],
      sessions: await db
        .select()
        .from(runSessions)
        .where(eq(runSessions.runId, runId)),
      attempts: await db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, runId)),
    });
    const before = await snapshot();

    await reconcile(handle.commandId);
    expect(await command(handle.commandId)).toMatchObject({
      settledFrom: "host_span",
      state: "succeeded",
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe("absence is never proof (D-B9)", () => {
  it("B8: a host-span settlement awaiting its canonical terminal defers the halt and permission-order checks instead of answering none", async () => {
    const unconfirmed = {
      id: randomUUID(),
      terminalEventId: null,
      settledFrom: "host_span",
      targetSessionId: randomUUID(),
    } as unknown as ExecutionCommand;

    await expect(findAgentPromptHalt(db, unconfirmed)).rejects.toBeInstanceOf(
      PromptOwnerDeferred,
    );
    await expect(
      permissionCheckpointOrder(db, unconfirmed, null),
    ).rejects.toBeInstanceOf(PromptOwnerDeferred);
    // A canonical row that simply has no terminal keeps the old answers.
    const legacy = {
      ...unconfirmed,
      settledFrom: null,
    } as unknown as ExecutionCommand;

    expect(await findAgentPromptHalt(db, legacy)).toBeNull();
    expect(await permissionCheckpointOrder(db, legacy, null)).toBe("unproven");
  });
});

describe("transcript re-anchor on confirmation (D-B10)", () => {
  it("B9: prompts dispatched after a host-span settlement move up to the confirming terminal; earlier ones stay", async () => {
    const runId = await seedRun(database.db, { projectId, status: "Running" });
    const settledAt = new Date();
    const row = (id: string, createdAt: Date, anchor: string) => ({
      id,
      runId,
      sequence: Number(anchor) + 1,
      role: "user" as const,
      content: id,
      supervisorEventId: anchor,
      promptDispatchKey: `dispatch-${id}`,
      createdAt,
    });

    await db
      .insert(runMessages)
      .values([
        row("before", new Date(settledAt.getTime() - 1_000), "2"),
        row("after", new Date(settledAt.getTime() + 1_000), "3"),
      ]);
    const moved = await db.transaction((tx) =>
      reanchorDispatchedPrompts(tx as unknown as Db, {
        runId,
        settledAt,
        anchor: 9n,
      }),
    );
    const anchors = Object.fromEntries(
      (
        await db
          .select({
            id: runMessages.id,
            anchor: runMessages.supervisorEventId,
          })
          .from(runMessages)
          .where(and(eq(runMessages.runId, runId)))
      ).map((message) => [message.id, message.anchor]),
    );

    expect(moved).toBe(1);
    expect(anchors).toEqual({ before: "2", after: "9" });
  });

  it("B9-wired: the canonical confirmation of a host-span settlement re-anchors a prompt dispatched after it", async () => {
    const { runId, client, hostSessionId } = await laggingSession();
    const handle = await prompt(client, hostSessionId);

    await untilReceipt(handle.commandId);
    const settled = await command(handle.commandId);

    expect(settled).toMatchObject({
      settledFrom: "host_span",
      terminalEventId: null,
    });
    // The next node's prompt, dispatched before this turn's reply was ingested.
    await db.insert(runMessages).values({
      id: randomUUID(),
      runId,
      sequence: 1_000_000,
      role: "user",
      content: "next node",
      supervisorEventId: "0",
      promptDispatchKey: `dispatch-${randomUUID()}`,
      createdAt: new Date(settled.completedAt!.getTime() + 1),
    });

    await fake.releaseIngest();
    await expect
      .poll(async () => (await command(handle.commandId)).terminalEventId, {
        timeout: 10_000,
      })
      .not.toBeNull();
    const [terminal] = await db
      .select({ runSequence: executionEvents.runSequence })
      .from(executionEvents)
      .where(
        eq(
          executionEvents.id,
          (await command(handle.commandId)).terminalEventId!,
        ),
      );
    const [moved] = await db
      .select({ anchor: runMessages.supervisorEventId })
      .from(runMessages)
      .where(
        and(eq(runMessages.runId, runId), eq(runMessages.sequence, 1_000_000)),
      );

    expect(terminal?.runSequence).not.toBeNull();
    expect(moved?.anchor).toBe(terminal!.runSequence!.toString());
  });
});
