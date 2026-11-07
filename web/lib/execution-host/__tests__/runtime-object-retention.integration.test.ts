import type { Db } from "@/lib/execution-host/db";
import type { PoolClient } from "pg";

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { publishRuntimeObject } from "@/lib/execution-host/runtime-objects";
import { MaisterError } from "@/lib/errors";
import { sweepExpiredRuntimeObjects } from "@/lib/execution-host/runtime-object-retention";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { recordCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import {
  seedProjectRow,
  seedRun,
  seedWorkspace,
} from "@/test-support/execution-host-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { createLocalDirectTransport } from "@/lib/execution-host/transports/local-direct";
import { SessionCreatePending } from "@/lib/execution-host/owned-session-create";
import {
  completeOwnedScratchCreate,
  dispatchOwnedScratchCreatePrompt,
} from "@/lib/scratch-runs/create-continuation";
import { initRepoWithWorktree, git } from "@/test-support/git-fixture";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runtime_object_retention_test",
  });
  db = testDatabase.db as unknown as Db;
}, 120_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("runtime object retention", () => {
  it("keeps a durable delete intent unavailable after a terminal host refusal", async () => {
    const project = await seedProjectRow(testDatabase.db);
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      status: "Review",
    });
    const { hosts, fake } = await fakeExecutionHosts(db, { runId });
    const client = await hosts.forRun(runId, { reason: "launch" });
    const objectId = randomUUID();

    await publishRuntimeObject({
      client,
      objectId,
      kind: "generated_artifact",
      logicalName: "refused.txt",
      mimeType: "text/plain",
      retentionClass: "ephemeral",
      expiresAt: "2026-09-04T11:59:00.000Z",
      bytes: new TextEncoder().encode("retained fixture"),
    });
    fake.transport.deleteRuntimeObject = async () => {
      throw new MaisterError("PRECONDITION", "fixture delete refusal");
    };
    const summary = await sweepExpiredRuntimeObjects({
      db,
      hosts,
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    const result = await testDatabase.pool.query<{ state: string }>(
      "select state from execution_runtime_objects where id = $1",
      [objectId],
    );

    expect(summary.failed).toBe(1);
    expect(result.rows).toEqual([{ state: "deleting" }]);
  });

  it("deletes only expired, unreferenced ephemeral objects through their original assignment", async () => {
    const project = await seedProjectRow(testDatabase.db);
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      status: "Review",
    });
    const { hosts, fake } = await fakeExecutionHosts(db, { runId });
    const client = await hosts.forRun(runId, { reason: "launch" });
    const now = new Date("2026-09-04T12:00:00.000Z");

    const publish = async (name: string, expiresAt: Date) => {
      const objectId = randomUUID();

      await publishRuntimeObject({
        client,
        objectId,
        kind: "generated_artifact",
        logicalName: name,
        mimeType: "text/plain",
        retentionClass: "ephemeral",
        expiresAt: expiresAt.toISOString(),
        bytes: new TextEncoder().encode(name),
      });

      return objectId;
    };
    const expired = await publish(
      "expired.txt",
      new Date("2026-09-04T11:59:00.000Z"),
    );
    const referenced = await publish(
      "referenced.txt",
      new Date("2026-09-04T11:59:00.000Z"),
    );
    const future = await publish(
      "future.txt",
      new Date("2026-09-04T12:01:00.000Z"),
    );

    await db.insert(schema.artifactInstances).values({
      id: randomUUID(),
      runId,
      kind: "generic_file",
      producer: "runner",
      locator: { kind: "execution-object", objectId: referenced },
      retention: "ephemeral",
    });

    const summary = await sweepExpiredRuntimeObjects({ db, hosts, now });
    const rows = await testDatabase.pool.query(
      `select id, state from execution_runtime_objects
       where id = any($1::text[]) order by id`,
      [[expired, referenced, future]],
    );

    // The sweep also re-examines the `deleting` queue left by the refusal case
    // above, so only this test's own rows are asserted exactly.
    expect(summary).toMatchObject({ deleted: 1, referenced: 1 });
    expect(summary.scanned).toBeGreaterThanOrEqual(2);
    expect(rows.rows).toEqual(
      [
        { id: expired, state: "deleted" },
        { id: referenced, state: "available" },
        { id: future, state: "available" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      fake
        .callsOf("deleteRuntimeObject")
        .map((call) => call.args[0])
        .filter((id) =>
          ([expired, referenced, future] as string[]).includes(String(id)),
        ),
    ).toEqual([expired]);
  }, 120_000);
  it("retains a private continuation reference before any session or public attachment exists", async () => {
    const root = await mkdtempReal("private-continuation-retention-");
    const previousUrl = process.env.MAISTER_SUPERVISOR_URL;
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") posts += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "EXECUTOR_UNAVAILABLE",
          message: "Original process ownership is unresolved",
          details: { reason: "session_process_owner_unconfirmed" },
        }),
      );
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Private continuation fixture has no port");
    process.env.MAISTER_SUPERVISOR_URL = `http://127.0.0.1:${address.port}`;
    try {
      const repository = await initRepoWithWorktree(root);
      const project = await seedProjectRow(testDatabase.db, {
        repoPath: repository.repoPath,
      });
      const runId = await seedRun(testDatabase.db, {
        projectId: project.id,
        runKind: "scratch",
      });
      const userId = randomUUID();

      await db
        .insert(fullSchema.users)
        .values({ id: userId, email: `${userId}@test.invalid` });
      await db
        .update(fullSchema.runs)
        .set({ createdByUserId: userId })
        .where(eq(fullSchema.runs.id, runId));
      await seedWorkspace(testDatabase.db, {
        runId,
        projectId: project.id,
        worktreePath: repository.worktreePath,
        parentRepoPath: repository.repoPath,
        branch: repository.branch,
      });
      await db.insert(fullSchema.scratchRuns).values({
        runId,
        projectId: project.id,
        initialPrompt: "Frozen private request",
        baseBranch: "main",
        baseCommit: await git(repository.repoPath, "rev-parse", "HEAD"),
        targetBranch: "main",
        createdByUserId: userId,
        dialogStatus: "Starting",
      });
      const { hosts, fake } = await fakeExecutionHosts(db, { runId });
      const original = await hosts.forRun(runId);
      const objectId = randomUUID();

      await publishRuntimeObject({
        client: original,
        objectId,
        kind: "generated_artifact",
        logicalName: "private-input.txt",
        mimeType: "text/plain",
        retentionClass: "ephemeral",
        expiresAt: "2026-09-04T11:59:00.000Z",
        bytes: new TextEncoder().encode("controlled private input"),
      });
      const wire = createLocalDirectTransport();
      const client = await createExecutionHosts({
        db,
        transport: {
          ...fake.transport,
          createSession: (envelope, options) =>
            wire.createSession(envelope, options),
        },
      }).forAssignment(original.assignment);

      const promptSentinel = `private-prompt-${randomUUID()}`;
      const environmentSentinel = `private-env-${randomUUID()}`;
      const create = () =>
        client.createOwnedSession(
          {
            variant: "scratch",
            scratchRunId: runId,
            turnId: client.assignment.id,
            promptOrdinal: 0,
          },
          async () => ({
            stepId: "scratch",
            executor: { agent: "claude", model: "mock" },
            adapterLaunch: { env: { PRIVATE_SENTINEL: environmentSentinel } },
          }),
          {
            prepareContinuation: async () => ({
              version: 1,
              kind: "initial",
              sourceMessageId: null,
              payload: {
                stepId: "scratch",
                prompt: promptSentinel,
                contentBlocks: [
                  {
                    type: "runtime_object",
                    objectId,
                    name: "private-input.txt",
                    mimeType: "text/plain",
                  },
                ],
              },
            }),
          },
        );
      const knownRefusal = new MaisterError(
        "UNAUTHORIZED",
        "Current actor cannot create this session",
        { details: { reason: "controlled_authorization_refusal" } },
      );

      await expect(
        client.createOwnedSession(
          {
            variant: "scratch",
            scratchRunId: runId,
            turnId: client.assignment.id,
            promptOrdinal: 0,
          },
          async () => {
            throw new Error("A refused owner cannot prepare private inputs");
          },
          {
            assertCommit: async () => {
              throw knownRefusal;
            },
          },
        ),
      ).rejects.toBe(knownRefusal);
      const nested = await client
        .createOwnedSession(
          {
            variant: "scratch",
            scratchRunId: runId,
            turnId: client.assignment.id,
            promptOrdinal: 0,
          },
          async () => {
            throw new Error("A refused owner cannot prepare private inputs");
          },
          {
            assertCommit: async (tx) => {
              try {
                await tx.execute(sql`SELECT ${environmentSentinel}::integer`);
              } catch (cause) {
                throw new MaisterError(
                  "CONFLICT",
                  "The owner operation was refused",
                  {
                    cause,
                    details: {
                      reason: "controlled_owner_conflict",
                      privateSnapshot: promptSentinel,
                    },
                  },
                );
              }
            },
          },
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      if (!(nested instanceof Error))
        throw new Error("Expected create refusal");
      const nestedLog = JSON.stringify(pino.stdSerializers.err(nested));

      expect(nested).toMatchObject({
        code: "CONFLICT",
        details: {
          reason: "controlled_owner_conflict",
          stage: "session_create_admission",
          sqlState: "22P02",
        },
      });
      expect(nested).not.toHaveProperty("cause");
      expect(nestedLog).not.toContain(promptSentinel);
      expect(nestedLog).not.toContain(environmentSentinel);
      const trigger = `private_create_${randomUUID().replaceAll("-", "")}`;

      await testDatabase.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='session.create' AND NEW.run_id='${runId}' THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='controlled_private_create_failure',MESSAGE='controlled atomic create refusal'; END IF; RETURN NEW; END $$`,
      );
      await testDatabase.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON execution_commands FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      let failed: unknown;

      try {
        failed = await create().then(
          () => null,
          (error: unknown) => error,
        );
      } finally {
        await testDatabase.pool.query(
          `DROP TRIGGER ${trigger} ON execution_commands`,
        );
        await testDatabase.pool.query(`DROP FUNCTION ${trigger}()`);
      }
      if (!(failed instanceof Error))
        throw new Error("Expected create refusal");
      const serialized = JSON.stringify(pino.stdSerializers.err(failed));

      expect(serialized).not.toContain(promptSentinel);
      expect(serialized).not.toContain(environmentSentinel);
      expect(failed).toMatchObject({
        code: "CRASH",
        details: {
          reason: "private_create_admission_failed",
          stage: "session_create_admission",
          sqlState: "23514",
          constraint: "controlled_private_create_failure",
        },
      });
      expect(failed).not.toHaveProperty("cause");
      expect(
        await db
          .select()
          .from(fullSchema.executionCommands)
          .where(eq(fullSchema.executionCommands.runId, runId)),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "session.create" }),
        ]),
      );
      const clientQueries = new Map<PoolClient, PoolClient["query"]>();
      let admissionInserted = false;
      let lostCommitReplies = 0;
      const loseAdmissionCommitReply = (connection: PoolClient): void => {
        if (clientQueries.has(connection)) return;
        const query = connection.query;

        clientQueries.set(connection, query);
        connection.query = new Proxy(query, {
          apply(target, receiver, argumentsList: unknown[]) {
            const command = argumentsList[0];
            const text =
              typeof command === "string"
                ? command
                : command && typeof command === "object" && "text" in command
                  ? command.text
                  : null;
            const parameters = argumentsList[1];

            if (
              typeof text === "string" &&
              text.startsWith('insert into "execution_commands"') &&
              Array.isArray(parameters) &&
              parameters.includes(runId) &&
              parameters.includes("session.create")
            )
              admissionInserted = true;
            const result: unknown = Reflect.apply(
              target,
              receiver,
              argumentsList,
            );

            if (
              text === "commit" &&
              admissionInserted &&
              lostCommitReplies === 0
            ) {
              lostCommitReplies += 1;

              return Promise.resolve(result).then(() => {
                throw Object.assign(new Error("Controlled lost COMMIT reply"), {
                  code: "ECONNRESET",
                });
              });
            }

            return result;
          },
        });
      };

      testDatabase.pool.on("acquire", loseAdmissionCommitReply);
      let admissionFailure: unknown;

      try {
        admissionFailure = await create().then(
          () => null,
          (error: unknown) => error,
        );
      } finally {
        testDatabase.pool.off("acquire", loseAdmissionCommitReply);
        for (const [connection, query] of clientQueries)
          connection.query = query;
      }
      expect(lostCommitReplies).toBe(1);
      expect(admissionFailure).toBeInstanceOf(SessionCreatePending);
      expect(posts).toBe(0);
      const [admitted] = await db
        .select()
        .from(fullSchema.executionCommands)
        .where(
          and(
            eq(fullSchema.executionCommands.runId, runId),
            eq(fullSchema.executionCommands.kind, "session.create"),
          ),
        );

      expect(admitted).toMatchObject({
        kind: "session.create",
        state: "queued",
        createIntent: { continuation: { kind: "initial" } },
      });
      expect(admissionFailure).toMatchObject({
        details: { commandId: admitted.id },
      });
      let lostLookupReplies = 0;
      const loseOriginalLookupReply = (connection: PoolClient): void => {
        if (clientQueries.has(connection)) return;
        const query = connection.query;

        clientQueries.set(connection, query);
        connection.query = new Proxy(query, {
          apply(target, receiver, argumentsList: unknown[]) {
            const command = argumentsList[0];
            const text =
              typeof command === "string"
                ? command
                : command && typeof command === "object" && "text" in command
                  ? command.text
                  : null;
            const parameters = argumentsList[1];
            const result: unknown = Reflect.apply(
              target,
              receiver,
              argumentsList,
            );

            if (
              lostLookupReplies === 0 &&
              typeof text === "string" &&
              text.startsWith("select ") &&
              text.includes('from "execution_commands"') &&
              Array.isArray(parameters) &&
              parameters.includes(runId)
            ) {
              lostLookupReplies += 1;

              return Promise.resolve(result).then(() => {
                throw Object.assign(new Error("Controlled lost SELECT reply"), {
                  code: "ECONNRESET",
                });
              });
            }

            return result;
          },
        });
      };

      clientQueries.clear();
      testDatabase.pool.on("acquire", loseOriginalLookupReply);
      let lookupFailure: unknown;

      try {
        lookupFailure = await create().then(
          () => null,
          (error: unknown) => error,
        );
      } finally {
        testDatabase.pool.off("acquire", loseOriginalLookupReply);
        for (const [connection, query] of clientQueries)
          connection.query = query;
      }
      expect(lostLookupReplies).toBe(1);
      expect(lookupFailure).toBeInstanceOf(SessionCreatePending);
      expect(lookupFailure).toMatchObject({
        details: { operationKey: `scratch-create:${original.assignment.id}:0` },
      });
      expect(lookupFailure).not.toHaveProperty("details.commandId");
      const [unchangedOwner] = await db
        .select()
        .from(fullSchema.runs)
        .where(eq(fullSchema.runs.id, runId));

      expect(unchangedOwner).toMatchObject({
        status: "Running",
        executionAssignmentId: original.assignment.id,
      });
      expect(posts).toBe(0);
      expect(
        await db
          .select()
          .from(fullSchema.runSessionIncarnations)
          .where(eq(fullSchema.runSessionIncarnations.runId, runId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(fullSchema.scratchAttachments)
          .where(eq(fullSchema.scratchAttachments.runId, runId)),
      ).toHaveLength(0);
      await sweepExpiredRuntimeObjects({
        db,
        hosts,
        now: new Date("2026-09-04T12:00:00.000Z"),
      });
      const [retained] = await db
        .select()
        .from(fullSchema.executionRuntimeObjects)
        .where(eq(fullSchema.executionRuntimeObjects.id, objectId));

      expect(retained).toMatchObject({
        state: "available",
        retentionHold: { reason: "open_command" },
      });
      expect(fake.callsOf("deleteRuntimeObject")).toHaveLength(0);
      let hostCreateObserved = false;
      const execution = await createExecutionHosts({
        db,
        transport: {
          ...fake.transport,
          createSession: async (request, options) => {
            const result = await fake.transport.createSession(request, options);

            hostCreateObserved = true;

            return result;
          },
        },
      }).executionFor(runId);
      const owner = {
        variant: "scratch" as const,
        scratchRunId: runId,
        turnId: original.assignment.id,
        promptOrdinal: 0,
      };
      const replay = () =>
        execution.client.createOwnedSession(
          owner,
          async () => {
            throw new Error(
              "Re-entry must retain the committed private request",
            );
          },
          {
            prepareContinuation: async () => {
              throw new Error(
                "Re-entry must retain the committed private continuation",
              );
            },
          },
        );
      let lostKnownCreateReplies = 0;
      let knownCreateReplyFaultsRemaining = 0;
      const loseKnownCreateReadReply = (connection: PoolClient): void => {
        if (clientQueries.has(connection)) return;
        const query = connection.query;

        clientQueries.set(connection, query);
        connection.query = new Proxy(query, {
          apply(target, receiver, argumentsList: unknown[]) {
            const command = argumentsList[0];
            const text =
              typeof command === "string"
                ? command
                : command && typeof command === "object" && "text" in command
                  ? command.text
                  : null;
            const parameters = argumentsList[1];

            if (
              hostCreateObserved &&
              knownCreateReplyFaultsRemaining > 0 &&
              typeof text === "string" &&
              text.startsWith("select ") &&
              text.includes('from "execution_commands"') &&
              Array.isArray(parameters) &&
              parameters.includes(admitted.id)
            ) {
              knownCreateReplyFaultsRemaining -= 1;
              lostKnownCreateReplies += 1;
              const fault = Object.assign(
                new Error("Controlled lost create outcome read"),
                { code: "ECONNRESET" },
              );
              const callback = argumentsList.at(-1);

              if (typeof callback === "function")
                return Reflect.apply(target, receiver, [
                  ...argumentsList.slice(0, -1),
                  (error: unknown, result: unknown) =>
                    Reflect.apply(callback, undefined, [
                      error ?? fault,
                      result,
                    ]),
                ]);
              const result: unknown = Reflect.apply(
                target,
                receiver,
                argumentsList,
              );

              return Promise.resolve(result).then(() => {
                throw fault;
              });
            }

            return Reflect.apply(target, receiver, argumentsList);
          },
        });
      };
      const faultKnownCreateReads = async (count: number): Promise<unknown> => {
        clientQueries.clear();
        knownCreateReplyFaultsRemaining = count;
        testDatabase.pool.on("acquire", loseKnownCreateReadReply);

        try {
          return await replay().then(
            () => null,
            (error: unknown) => error,
          );
        } finally {
          testDatabase.pool.off("acquire", loseKnownCreateReadReply);
          for (const [connection, query] of clientQueries)
            connection.query = query;
        }
      };
      const lostAckAndReload = await faultKnownCreateReads(2);

      expect(lostKnownCreateReplies).toBe(2);
      expect(fake.receipts.get(admitted.id)).toMatchObject({ httpStatus: 201 });
      expect(lostAckAndReload).toBeInstanceOf(SessionCreatePending);
      expect(lostAckAndReload).toMatchObject({
        details: { commandId: admitted.id },
      });
      const lostReceiptFold = await faultKnownCreateReads(1);

      expect(lostKnownCreateReplies).toBe(3);
      expect(lostReceiptFold).toBeInstanceOf(SessionCreatePending);
      expect(lostReceiptFold).toMatchObject({
        details: { commandId: admitted.id },
      });
      const session = await replay();
      const lostReadoption = await faultKnownCreateReads(1);

      expect(lostKnownCreateReplies).toBe(4);
      expect(lostReadoption).toBeInstanceOf(SessionCreatePending);
      expect(lostReadoption).toMatchObject({
        details: { commandId: admitted.id },
      });
      expect(await replay()).toMatchObject({ sessionId: session.sessionId });
      const continuation = await completeOwnedScratchCreate(
        db,
        execution,
        owner,
        session,
      );

      if (!continuation)
        throw new Error("Original private continuation is missing");
      await dispatchOwnedScratchCreatePrompt(
        db,
        execution,
        owner,
        session.sessionId,
        continuation,
      );
      const creates = await db
        .select()
        .from(fullSchema.executionCommands)
        .where(eq(fullSchema.executionCommands.runId, runId));

      expect(
        creates
          .filter((command) => command.kind === "session.create")
          .map((command) => command.id),
      ).toEqual([admitted.id]);
      expect(
        creates.filter((command) => command.kind === "session.prompt"),
      ).toHaveLength(1);
      expect(fake.callsOf("createSession")).toHaveLength(1);
    } finally {
      if (previousUrl === undefined) delete process.env.MAISTER_SUPERVISOR_URL;
      else process.env.MAISTER_SUPERVISOR_URL = previousUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fair runtime object retention (AT-14)", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const expired = "2026-09-04T11:59:00.000Z";
  let fairDatabase: StartedPostgresTestDb;
  let fairDb: Db;

  beforeAll(async () => {
    fairDatabase = await startMainPostgresTestDb({
      databaseName: "runtime_object_fair_retention_test",
    });
    fairDb = fairDatabase.db as unknown as Db;
  }, 120_000);

  afterAll(async () => {
    await fairDatabase?.stop();
  });

  async function runWithHost(status = "Review") {
    const project = await seedProjectRow(fairDatabase.db);
    const runId = await seedRun(fairDatabase.db, {
      projectId: project.id,
      status,
    });
    const { hosts, fake } = await fakeExecutionHosts(fairDb, { runId });
    const client = await hosts.forRun(runId, { reason: "launch" });

    return { project, runId, hosts, fake, client };
  }

  async function publish(
    client: Awaited<ReturnType<typeof runWithHost>>["client"],
    name: string,
    retentionClass: "run" | "delivery" | "ephemeral" = "ephemeral",
  ) {
    const objectId = randomUUID();

    await publishRuntimeObject({
      client,
      objectId,
      kind: "generated_artifact",
      logicalName: name,
      mimeType: "text/plain",
      retentionClass,
      expiresAt: retentionClass === "ephemeral" ? expired : null,
      bytes: new TextEncoder().encode(name),
    });

    return objectId;
  }

  async function reference(
    runId: string,
    objectId: string,
    requiredFor?: ("review" | "merge")[],
  ) {
    await fairDb.insert(schema.artifactInstances).values({
      id: randomUUID(),
      runId,
      kind: "generic_file",
      producer: "runner",
      locator: { kind: "execution-object", objectId },
      retention: "ephemeral",
      ...(requiredFor ? { requiredFor } : {}),
    });
  }

  async function stateOf(objectId: string) {
    const result = await fairDatabase.pool.query<{
      state: string;
      retention_hold: { reason?: string } | null;
    }>(
      "select state, retention_hold from execution_runtime_objects where id = $1",
      [objectId],
    );

    return result.rows[0];
  }

  async function cursor() {
    const result = await fairDatabase.pool.query<{
      cursor_id: string | null;
    }>("select cursor_id from execution_runtime_object_retention_progress");

    return result.rows;
  }

  async function sweepUntilWrapped(
    hosts: Awaited<ReturnType<typeof runWithHost>>["hosts"],
    limit: number,
  ) {
    for (let sweep = 0; sweep < 50; sweep += 1) {
      await sweepExpiredRuntimeObjects({ db: fairDb, hosts, now, limit });
      if ((await cursor())[0]?.cursor_id === null) return sweep + 1;
    }
    throw new Error("retention scan never wrapped");
  }

  it("persists its keyset cursor across sweeps and wraps once the scan is exhausted", async () => {
    const { runId, hosts, client } = await runWithHost();
    const first = await publish(client, "p-0.txt");
    const second = await publish(client, "p-1.txt");

    await reference(runId, first);
    await reference(runId, second);
    const eligible = [
      await publish(client, "e-0.txt"),
      await publish(client, "e-1.txt"),
      await publish(client, "e-2.txt"),
    ];
    const summaries = [];

    for (let sweep = 0; sweep < 3; sweep += 1)
      summaries.push(
        await sweepExpiredRuntimeObjects({ db: fairDb, hosts, now, limit: 2 }),
      );

    expect(summaries.map((summary) => summary.deleted)).toEqual([0, 2, 1]);
    expect(summaries.map((summary) => summary.protected)).toEqual([2, 0, 0]);
    for (const objectId of eligible)
      expect((await stateOf(objectId)).state).toBe("deleted");
    // The third sweep examined fewer rows than its page and wrapped around;
    // the next one starts over and leaves its marker on the last examined row.
    expect(await cursor()).toEqual([{ cursor_id: null }]);
    expect(
      await sweepExpiredRuntimeObjects({ db: fairDb, hosts, now, limit: 2 }),
    ).toMatchObject({ scanned: 2, protected: 2, deleted: 0 });
    expect(await cursor()).toEqual([{ cursor_id: second }]);
  });

  it("reaches an eligible object behind pages of protected ones and records why each was kept", async () => {
    const { runId, hosts, client } = await runWithHost();
    const protectedIds: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const objectId = await publish(client, `protected-${index}.txt`);

      await reference(runId, objectId);
      protectedIds.push(objectId);
    }
    const eligible = await publish(client, "eligible.txt");

    await sweepUntilWrapped(hosts, 2);
    expect((await stateOf(eligible)).state).toBe("deleted");
    for (const objectId of protectedIds)
      expect(await stateOf(objectId)).toMatchObject({
        state: "available",
        retention_hold: { reason: "referenced_artifact" },
      });
  });

  it("cannot delete an object while a reference is being recorded under the object lock", async () => {
    const { runId, hosts, client } = await runWithHost();
    const objectId = await publish(client, "racer.txt");
    const holder = await fairDatabase.pool.connect();

    try {
      await holder.query("BEGIN");
      await holder.query(
        "select id from execution_runtime_objects where id = $1 for update",
        [objectId],
      );
      const sweep = sweepUntilWrapped(hosts, 100);

      await holder.query(
        `insert into artifact_instances (id, run_id, kind, producer, locator, retention)
         values ($1, $2, 'generic_file', 'runner', $3::jsonb, 'ephemeral')`,
        [
          randomUUID(),
          runId,
          JSON.stringify({ kind: "execution-object", objectId }),
        ],
      );
      await holder.query("COMMIT");
      await sweep;
      expect(await stateOf(objectId)).toMatchObject({
        state: "available",
        retention_hold: { reason: "referenced_artifact" },
      });
    } finally {
      holder.release();
    }
  });

  it("refuses a new reference to an object already claimed for deletion", async () => {
    const { runId, hosts, fake, client } = await runWithHost();
    const objectId = await publish(client, "claimed.txt");
    const original = fake.transport.deleteRuntimeObject.bind(fake.transport);

    fake.transport.deleteRuntimeObject = async () => {
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "fixture host lost", {
        details: { transport: UNKNOWN_OUTCOME_DETAIL },
      });
    };
    await sweepUntilWrapped(hosts, 100);
    expect((await stateOf(objectId)).state).toBe("deleting");
    await expect(
      recordCurrentArtifact(
        {
          runId,
          kind: "generic_file",
          producer: "runner",
          locator: { kind: "execution-object", objectId },
          retention: "ephemeral",
        },
        fairDb,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "runtime_object_missing" },
    });
    // The claim completes through its own host once it is reachable again.
    fake.transport.deleteRuntimeObject = original;
    const summary = await recoverExecutionCommands({
      db: fairDb,
      transport: fake.transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect((await stateOf(objectId)).state).toBe("deleted");
  });

  it("holds delivery bytes until delivery is confirmed and required evidence past the run deadline", async () => {
    const { project, runId, hosts, client } = await runWithHost("Done");

    await fairDb.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project.id,
      branch: "maister/gc",
      worktreePath: `/tmp/maister-gc-${runId}`,
      parentRepoPath: project.repoPath,
      baseBranch: "main",
      prUrl: "https://example.invalid/pr/1",
      prState: "open",
      scheduledRemovalAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    const delivery = await publish(client, "delivery.txt", "delivery");
    const required = await publish(client, "required.txt", "run");
    const plain = await publish(client, "plain.txt", "run");

    await reference(runId, required, ["merge"]);
    await sweepUntilWrapped(hosts, 100);
    expect(await stateOf(delivery)).toMatchObject({
      state: "available",
      retention_hold: { reason: "delivery_unconfirmed" },
    });
    expect(await stateOf(required)).toMatchObject({
      state: "available",
      retention_hold: { reason: "required_evidence" },
    });
    expect((await stateOf(plain)).state).toBe("deleted");

    await fairDb
      .update(schema.workspaces)
      .set({ prState: "merged", prMergedAt: now })
      .where(eq(schema.workspaces.runId, runId));
    await sweepUntilWrapped(hosts, 100);
    expect((await stateOf(delivery)).state).toBe("deleted");
    expect((await stateOf(required)).state).toBe("available");
  });

  // ADR-181 (owner, 2026-09-23): a Failed worktree expires by the workspace
  // TTL, but its run's evidence is not part of that decision — the objects a
  // failed attempt produced stay past the workspace deadline a Done run's go at.
  it("keeps a Failed run's run-class objects past the workspace deadline", async () => {
    const { project, runId, hosts, client } = await runWithHost("Failed");

    await fairDb.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project.id,
      branch: "maister/gc-failed",
      worktreePath: `/tmp/maister-gc-${runId}`,
      parentRepoPath: project.repoPath,
      baseBranch: "main",
      scheduledRemovalAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    const plain = await publish(client, "failure-log.txt", "run");

    await sweepUntilWrapped(hosts, 100);
    expect((await stateOf(plain)).state).toBe("available");
  });

  it("keeps a lost delete retrying through recovery without a second claim", async () => {
    const { hosts, fake, client } = await runWithHost();
    const objectId = await publish(client, "lost.txt");
    const original = fake.transport.deleteRuntimeObject.bind(fake.transport);
    let attempts = 0;

    fake.transport.deleteRuntimeObject = async () => {
      attempts += 1;
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "fixture host lost", {
        details: { transport: UNKNOWN_OUTCOME_DETAIL },
      });
    };
    await sweepUntilWrapped(hosts, 100);
    await sweepUntilWrapped(hosts, 100);
    expect(await stateOf(objectId)).toMatchObject({
      state: "deleting",
      retention_hold: { reason: "delete_pending" },
    });
    expect(attempts).toBe(1);
    fake.transport.deleteRuntimeObject = original;
    const summary = await recoverExecutionCommands({
      db: fairDb,
      transport: fake.transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect((await stateOf(objectId)).state).toBe("deleted");
  });
});
