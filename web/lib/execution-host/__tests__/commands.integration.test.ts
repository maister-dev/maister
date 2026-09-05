// ADR-166 T1.2 — execution_commands ledger (C1–C5): the E-EH-12 payload
// projection and the CAS state machine.

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
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
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import {
  startAsyncPrompt,
  waitForPromptCompletion,
} from "@/lib/execution-host/deliverer";
import { buildEnvelope } from "@/lib/execution-host/ledger";
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
const SENTINEL_PATH = "/secret/worktree/SENTINEL-PATH";

// Keys that carry a path, a body, a secret, or an argv token: none may
// survive the projection at any depth.
const FORBIDDEN_KEYS = [
  "path",
  "repoPath",
  "worktreePath",
  "confineRoot",
  "capabilityProfilePath",
  "prompt",
  "contentBlocks",
  "env",
  "args",
  "command",
  "apiKey",
  "mcpServers",
  "adapterLaunch",
  "hooksConfig",
  "enforcementProfile",
  "contextMounts",
];

function deepKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => deepKeys(item, `${prefix}[${i}]`));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => [
      `${prefix}${key}`,
      ...deepKeys(child, `${prefix}${key}.`),
    ],
  );
}

function leafNames(value: unknown): string[] {
  return deepKeys(value).map((k) =>
    k
      .split(".")
      .pop()!
      .replace(/\[\d+\]$/, ""),
  );
}

describe("insertCommand", () => {
  it("C1: the per-kind ALLOW-list projection — ids, names and counts survive; no path, body, secret or argv key does", async () => {
    const { runId, assignment } = await seedAssignment();
    const insert = (
      kind: Parameters<typeof insertCommand>[1]["kind"],
      payload: unknown,
    ) =>
      insertCommand(db, {
        runId,
        assignmentId: assignment.id,
        hostId,
        assignmentEpoch: assignment.epoch,
        kind,
        maxAttempts: 3,
        payload,
      });

    const create = await insert("session.create", {
      executionWorkspaceId: "ws_" + "b".repeat(32),
      stepId: "plan",
      nodeAttemptId: "attempt-1",
      sessionName: "default",
      resumeSessionId: "acp-prior",
      readOnlySession: false,
      autoApprovePermissions: true,
      reapOnEndTurn: false,
      executor: {
        agent: "claude",
        model: "claude-sonnet-4-6",
        env: { ANTHROPIC_AUTH_TOKEN: SENTINEL_TOKEN },
      },
      runner: {
        adapter: "claude",
        model: "claude-sonnet-4-6",
        provider: {
          kind: "anthropic_compatible",
          baseUrl: "https://x/" + SENTINEL_TOKEN,
        },
        env: { ZAI_API_KEY: SENTINEL_TOKEN },
        apiKey: SENTINEL_TOKEN,
      },
      capabilityProfileObjectId: "f7f4ea9b-598b-4f97-97b5-5ca52d46056e",
      outputObjects: [
        {
          objectId: "75cb17b1-ea05-45af-9209-15f181b10925",
          kind: "plan_review",
          logicalName: "plan-review.json",
          mimeType: "application/json",
          generation: 1,
          retentionClass: "run",
          envName: "MAISTER_PLAN_REVIEW_FILE",
        },
      ],
      adapterLaunch: {
        env: { MAISTER_CAPABILITY_PROFILE: SENTINEL_PATH },
        preArgs: ["--x"],
      },
      mcpServers: [
        {
          name: "maister",
          command: "/bin/" + SENTINEL_PATH,
          args: [SENTINEL_TOKEN],
          env: { T: SENTINEL_TOKEN },
        },
        {
          name: "other",
          transport: "http",
          url: "https://h/" + SENTINEL_TOKEN,
        },
      ],
      hooksConfig: { repetition: { max: 3 } },
      // A stray body on the wrong kind never leaks either.
      prompt: SENTINEL_PROMPT,
    });
    const prompt = await insert("session.prompt", {
      stepId: "plan",
      nodeAttemptId: "attempt-1",
      prompt: SENTINEL_PROMPT,
      contentBlocks: [
        { type: "text", text: SENTINEL_PROMPT },
        { type: "resource_link", uri: "file://" + SENTINEL_PATH, name: "f" },
      ],
      readOnlyTurn: true,
    });
    const adopt = await insert("workspace.adopt", {
      runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: SENTINEL_PATH,
      repoPath: SENTINEL_PATH + "/repo",
      contextMounts: [
        {
          slug: "api",
          mountPath: SENTINEL_PATH + "/ctx",
          repoPath: SENTINEL_PATH,
          committish: "0123456789abcdef",
          ref: "main",
          projectId: "p",
        },
      ],
    });
    const input = await insert("session.input", {
      kind: "permission",
      action: "select",
      requestId: "r1",
      optionId: "allow",
      reason: "because",
      extra: SENTINEL_TOKEN,
    });
    const teardown = await Promise.all([
      insert("session.cancel", { anything: SENTINEL_TOKEN }),
      insert("session.checkpoint", { anything: SENTINEL_TOKEN }),
      insert("session.delete", { anything: SENTINEL_TOKEN }),
      insert("workspace.release", { anything: SENTINEL_TOKEN }),
    ]);

    expect(create.state).toBe("queued");
    expect(create.attempts).toBe(0);
    expect(create.completedAt).toBeNull();

    for (const row of [create, prompt, adopt, input, ...teardown]) {
      const persisted = await readCommand(row.id);
      const json = JSON.stringify(persisted.payload);

      expect(json, row.kind).not.toContain(SENTINEL_TOKEN);
      expect(json, row.kind).not.toContain(SENTINEL_PROMPT);
      expect(json, row.kind).not.toContain(SENTINEL_PATH);
      for (const key of leafNames(persisted.payload)) {
        expect(FORBIDDEN_KEYS, `${row.kind} leaked key ${key}`).not.toContain(
          key,
        );
      }
    }

    expect((await readCommand(create.id)).payload).toEqual({
      executionWorkspaceId: "ws_" + "b".repeat(32),
      stepId: "plan",
      nodeAttemptId: "attempt-1",
      sessionName: "default",
      resumeSessionId: "acp-prior",
      readOnlySession: false,
      autoApprovePermissions: true,
      reapOnEndTurn: false,
      executor: { agent: "claude", model: "claude-sonnet-4-6" },
      runner: {
        adapter: "claude",
        model: "claude-sonnet-4-6",
        provider: { kind: "anthropic_compatible" },
      },
      mcpServerCount: 2,
      hasCapabilityProfile: true,
      hasCapabilityInstructions: false,
      runtimeOutputCount: 1,
      hasAdapterLaunch: true,
      hasHooksConfig: true,
      hasEnforcementProfile: false,
    });
    expect((await readCommand(prompt.id)).payload).toEqual({
      stepId: "plan",
      promptBytes: Buffer.byteLength(SENTINEL_PROMPT, "utf8"),
      contentBlockCount: 2,
    });
    expect((await readCommand(adopt.id)).payload).toEqual({
      runId,
      projectSlug: "demo",
      kind: "git_worktree",
      contextMountCount: 1,
    });
    expect((await readCommand(input.id)).payload).toEqual({
      kind: "permission",
      action: "select",
      requestId: "r1",
      optionId: "allow",
      reason: "because",
    });
    for (const row of teardown) {
      expect((await readCommand(row.id)).payload, row.kind).toEqual({});
    }
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

describe("prompt receipt reconciliation", () => {
  it("keeps a terminal admission receipt as evidence until its canonical event arrives", async () => {
    const { runId, assignment } = await seedAssignment();
    const row = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      maxAttempts: 3,
      payload: { stepId: "plan", prompt: "lost admission acknowledgement" },
    });
    const terminalBody = { stopReason: "end_turn", meta: null };
    const handle = await startAsyncPrompt({
      db,
      command: row,
      envelope: buildEnvelope({
        commandId: row.id,
        kind: "session.prompt",
        hostKey: "eh_test",
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        runId,
        payload: row.payload,
      }),
      start: async () => {
        throw new MaisterError("EXECUTOR_UNAVAILABLE", "admission ACK lost", {
          details: { transport: UNKNOWN_OUTCOME_DETAIL },
        });
      },
      lookupReceipt: async () => ({
        commandId: row.id,
        runId,
        kind: "session.prompt",
        assignmentEpoch: assignment.epoch,
        phase: "completed",
        httpStatus: 200,
        body: terminalBody,
        receivedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        eventId: randomUUID(),
        inflight: false,
      }),
      sleep: async () => {},
    });

    expect(handle).toEqual({ commandId: row.id });
    expect(await readCommand(row.id)).toMatchObject({
      state: "accepted",
      result: null,
      lastError: null,
    });
  });

  it("keeps canonical event authority after release, then accepts its agreeing terminal receipt", async () => {
    const { runId, assignment } = await seedAssignment();
    const row = await insertCommand(db, {
      runId,
      assignmentId: assignment.id,
      hostId,
      assignmentEpoch: assignment.epoch,
      kind: "session.prompt",
      maxAttempts: 3,
      payload: { stepId: "plan", prompt: "checkpoint race" },
    });

    await claimDelivering(db, row.id, 0);
    await markAccepted(db, row.id, 1);
    await testDatabase.pool.query(
      `update execution_assignments
       set state = 'released', ended_at = now(), released_reason = 'checkpointed'
       where id = $1`,
      [assignment.id],
    );

    const terminalBody = { stopReason: "cancelled" };
    const terminalReceipt = {
      commandId: row.id,
      runId,
      kind: "session.prompt" as const,
      assignmentEpoch: assignment.epoch,
      phase: "completed" as const,
      httpStatus: 200,
      body: terminalBody,
      receivedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      eventId: null,
      inflight: false,
    };
    const abort = new AbortController();
    const abortTimer = setTimeout(() => abort.abort(), 25);

    await expect(
      waitForPromptCompletion({
        db,
        handle: { commandId: row.id },
        signal: abort.signal,
        assignmentIsCurrent: async () => false,
        lookupReceipt: async () => terminalReceipt,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "prompt_wait_aborted" },
    });
    clearTimeout(abortTimer);
    expect(await readCommand(row.id)).toMatchObject({
      state: "accepted",
      result: null,
      lastError: null,
    });

    await markSucceeded(db, row.id, null, terminalBody);
    const publishedReceipt = {
      ...terminalReceipt,
      eventId: randomUUID(),
    };
    const result = await waitForPromptCompletion({
      db,
      handle: { commandId: row.id },
      assignmentIsCurrent: async () => false,
      lookupReceipt: async () => publishedReceipt,
    });

    expect(result).toEqual(terminalBody);
    expect(await readCommand(row.id)).toMatchObject({
      state: "succeeded",
      result: terminalBody,
      lastError: null,
    });
  });
});
