import type { Db } from "../db";
import type { PromptOwnerRegistry } from "../prompt-owners";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  applyClaimedPromptOwner,
  applyPromptOwner,
  claimPromptOwner,
} from "../prompt-owner-application";
import {
  inspectPromptApplication,
  rearmPromptApplication,
} from "../prompt-application-recovery";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerDeferred,
  PromptOwnerInvariantError,
} from "../prompt-owners";
import { mintAssignment } from "../assignments";
import { storePromptRequest } from "../command-request";
import { asAssignmentId, asCommandId } from "../types";

import { executionCommands, runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
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
let db: Db;
let projectId: string;
let hostId: string;
let hostKey: string;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "prompt_application_recovery",
  });
  db = database.db as unknown as Db;
  projectId = await seedProject(database.db);
  const host = await seedLocalHost(database.db);

  hostId = host.id;
  hostKey = host.hostKey;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

/** Preflight refusal is a terminal prompt with no host output to fetch. */
async function terminalPrompt(): Promise<{ commandId: string; runId: string }> {
  const runId = await seedRun(database.db, { projectId, status: "Running" });
  const assignment = await db.transaction((tx) =>
    mintAssignment(tx as Db, { runId, hostId, reason: "launch" }),
  );
  const commandId = randomUUID();
  const targetSessionId = randomUUID();
  const createdAt = new Date();
  const payload = { stepId: "fixture", prompt: "not dispatched" };
  const request = storePromptRequest({
    targetSessionId,
    envelope: {
      command: {
        id: asCommandId(commandId),
        kind: "session.prompt",
        issuedAt: createdAt.toISOString(),
      },
      fence: {
        hostKey,
        assignmentId: asAssignmentId(assignment.id),
        assignmentEpoch: assignment.epoch,
        runId,
      },
      payload,
    },
  });

  await db.insert(executionCommands).values({
    id: commandId,
    runId,
    executionAssignmentId: assignment.id,
    executionHostId: hostId,
    assignmentEpoch: assignment.epoch,
    kind: "session.prompt",
    targetSessionId,
    payload,
    createdAt,
    state: "failed",
    maxAttempts: 3,
    completedAt: new Date(),
    lastError: {
      code: "PRECONDITION",
      message: "Preflight refused dispatch",
      details: { transport: "not_sent" },
    },
    ownerKind: "flow_node_attempt",
    ownerRef: {
      version: 1,
      variant: "node",
      nodeAttemptId: randomUUID(),
      promptOrdinal: 0,
      runId,
      runSessionId: randomUUID(),
      incarnationId: randomUUID(),
      assignmentId: assignment.id,
      assignmentEpoch: assignment.epoch,
    },
    logicalOperationKey: `flow_node_attempt:node:${commandId}:0`,
    ...request,
    applicationState: "pending",
  });

  return { commandId, runId };
}

function successOwners(): PromptOwnerRegistry {
  return createPromptOwnerRegistry([
    definePromptOwnerAdapter("flow_node_attempt", async ({ owner }) => ({
      apply: async (tx) => {
        await tx
          .update(runs)
          .set({ status: "Failed" })
          .where(eq(runs.id, owner.ref.runId));

        return "applied";
      },
    })),
  ]);
}

async function command(commandId: string) {
  const [row] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  return row;
}

const cliObservation = z.object({
  commandId: z.string().guid(),
  observationToken: z.string().regex(/^[a-f0-9]{32}$/),
  applicationState: z.string(),
  completionAppliedAt: z.string().nullable(),
  action: z.string().optional(),
});

function recoveryCli(
  args: readonly string[],
  cwd: string,
): Promise<z.infer<typeof cliObservation>> {
  const executableArgs = [
    "--import",
    path.resolve("node_modules/tsx/dist/loader.mjs"),
    "--import",
    path.resolve("scripts/_register-shim.mjs"),
    path.resolve("scripts/recover-prompt-application.ts"),
    ...args,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      executableArgs,
      {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 65_536,
        env: {
          ...process.env,
          NODE_ENV: "test",
          DB_URL: database.databaseUrl,
          TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          DOTENV_CONFIG_QUIET: "true",
        },
      },
      (error, stdout) => {
        if (error) {
          reject(
            new MaisterError(
              "PRECONDITION",
              "Recovery CLI smoke process failed",
              { details: { operation: args[0], exitCode: error.code } },
            ),
          );

          return;
        }
        try {
          const jsonStart = stdout.lastIndexOf("\n{\n");

          resolve(
            cliObservation.parse(
              JSON.parse(jsonStart < 0 ? stdout : stdout.slice(jsonStart + 1)),
            ),
          );
        } catch {
          reject(
            new MaisterError(
              "PRECONDITION",
              "Recovery CLI returned an invalid observation",
              { details: { operation: args[0] } },
            ),
          );
        }
      },
    );
  });
}

describe("bounded and fenced terminal prompt application", () => {
  it("records CLI recovery without applying domain changes before the persistent application path runs", async () => {
    const fixture = await terminalPrompt();
    const cliCwd = await mkdtemp(
      path.join(tmpdir(), "maister-prompt-recovery-cli-"),
    );

    try {
      await db
        .update(executionCommands)
        .set({
          applicationState: "poisoned",
          applicationAttempts: 5,
          applicationError: {
            reason: "prompt_owner_poisoned",
            phase: "prepare",
            causeCode: "PRECONDITION",
            causeReason: "command_in_progress",
            stage: "output",
          },
        })
        .where(eq(executionCommands.id, fixture.commandId));
      const inspected = await recoveryCli(
        ["inspect", "--command", fixture.commandId],
        cliCwd,
      );

      expect(inspected.applicationState).toBe("poisoned");
      const requested = await recoveryCli(
        [
          "reapply",
          "--command",
          fixture.commandId,
          "--observation-token",
          inspected.observationToken,
        ],
        cliCwd,
      );

      expect(requested).toMatchObject({
        action: "reapply_requested",
        applicationState: "pending",
        completionAppliedAt: null,
      });
      const pending = await command(fixture.commandId);
      const [beforeApplication] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, fixture.runId));

      expect(pending.applicationState).toBe("pending");
      expect(pending.applicationClaimOwner).toBeNull();
      expect(pending.completionAppliedAt).toBeNull();
      expect(beforeApplication.status).toBe("Running");
      expect(
        await applyPromptOwner({
          db,
          owners: successOwners(),
          ...fixture,
          signal: AbortSignal.timeout(10_000),
        }),
      ).toBe("applied");
      const [afterApplication] = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, fixture.runId));

      expect(afterApplication.status).toBe("Failed");
      expect(
        (await command(fixture.commandId)).completionAppliedAt,
      ).not.toBeNull();
    } finally {
      await rm(cliCwd, { recursive: true, force: true });
    }
  }, 45_000);

  it("retains ninth-field PRECONDITION details in runtime read contention diagnostics", async () => {
    const fixture = await terminalPrompt();
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("flow_node_attempt", async ({ onProgress }) => {
        onProgress?.("output");
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Runtime object read capacity is busy",
          {
            details: {
              commandId: fixture.commandId,
              eventId: "event-42",
              objectId: "object-42",
              reason: "runtime_object_read_busy",
              attempts: 5,
              causeCode: "PRECONDITION",
              causeReason: "command_in_progress",
              causeMessage: "Object content read is in progress",
              causeDetails: {
                httpStatus: 409,
                reason: "command_in_progress",
                token: "private-value",
              },
            },
          },
        );
      }),
    ]);

    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("deferred");
    const row = await command(fixture.commandId);

    expect(row.applicationAttempts).toBe(0);
    expect(row.applicationError).toMatchObject({
      stage: "output",
      causeDetails: {
        commandId: fixture.commandId,
        eventId: "event-42",
        causeCode: "PRECONDITION",
        causeReason: "command_in_progress",
        causeDetails: { httpStatus: 409, reason: "command_in_progress" },
      },
    });
    expect(JSON.stringify(row.applicationError)).not.toContain("private-value");
  });

  it("retains the original recovery cause through service retries, application retries, deferral and success", async () => {
    const fixture = await terminalPrompt();
    const original = {
      reason: "prompt_owner_poisoned",
      phase: "prepare",
      stage: "output",
      causeCode: "PRECONDITION",
      causeReason: "command_in_progress",
      causeMessage: "Object read is busy",
      causeDetails: { httpStatus: 409, reason: "command_in_progress" },
      classification: "exhausted",
    } as const;

    await db
      .update(executionCommands)
      .set({
        applicationState: "poisoned",
        applicationAttempts: 5,
        applicationError: original,
      })
      .where(eq(executionCommands.id, fixture.commandId));
    const observed = await inspectPromptApplication(db, fixture.commandId);
    const rearmed = await rearmPromptApplication({
      db,
      commandId: fixture.commandId,
      expectedToken: observed.observationToken,
    });
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "flow_node_attempt",
        async ({ command: current }) => {
          if (current.applicationError?.reason === "prompt_owner_rearmed")
            throw new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "Read capacity is busy",
              { details: { reason: "runtime_object_read_busy" } },
            );
          if (current.applicationError?.reason === "prompt_owner_service_retry")
            throw new MaisterError("PRECONDITION", "Publication is not ready", {
              details: { reason: "publication_pending" },
            });
          if (current.applicationError?.reason === "prompt_owner_retry")
            throw new PromptOwnerDeferred("awaiting_projection");

          return { apply: async () => "applied" };
        },
      ),
    ]);

    for (let step = 0; step < 4; step++) {
      expect(
        await applyPromptOwner({
          db,
          owners,
          ...fixture,
          signal: AbortSignal.timeout(10_000),
        }),
      ).toBe(step === 3 ? "applied" : "deferred");
      const latest = await command(fixture.commandId);

      expect(latest.applicationError).toMatchObject({
        recoveryRequestedAt: rearmed.error?.recoveryRequestedAt,
        previousAttempts: 5,
        recoveryOrigin: original,
      });
      await db
        .update(executionCommands)
        .set({ applicationNextRetryAt: null })
        .where(eq(executionCommands.id, fixture.commandId));
    }
    const completed = await command(fixture.commandId);

    expect(completed.applicationError?.reason).toBe("prompt_owner_recovered");
    expect(completed.applicationError?.deferredSince).toBeDefined();
    expect(completed.completionAppliedAt).not.toBeNull();
  });

  it("keeps the bounded teardown deadline when service and application failures alternate with deferrals", async () => {
    const fixture = await terminalPrompt();
    const deferredSince = new Date(Date.now() - 180_000).toISOString();

    await db
      .update(executionCommands)
      .set({
        applicationError: {
          reason: "prompt_owner_deferred",
          phase: "prepare",
          deferredSince,
          causeDetails: { causeCode: "agent_session_teardown_pending" },
        },
      })
      .where(eq(executionCommands.id, fixture.commandId));
    const failures = [
      new MaisterError("EXECUTOR_UNAVAILABLE", "Transient host connection", {
        details: { reason: "host_unavailable" },
      }),
      new MaisterError("PRECONDITION", "Transient publication contention", {
        details: { reason: "publication_contention" },
      }),
    ];

    for (const failure of failures) {
      const owners = createPromptOwnerRegistry([
        definePromptOwnerAdapter("flow_node_attempt", async () => {
          throw failure;
        }),
      ]);

      expect(
        await applyPromptOwner({
          db,
          owners,
          ...fixture,
          signal: AbortSignal.timeout(10_000),
        }),
      ).toBe("deferred");
      expect(
        (await command(fixture.commandId)).applicationError?.deferredSince,
      ).toBe(deferredSince);
      await db
        .update(executionCommands)
        .set({ applicationNextRetryAt: null })
        .where(eq(executionCommands.id, fixture.commandId));
    }
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "flow_node_attempt",
        async () => {
          throw new PromptOwnerDeferred("agent_session_teardown_pending");
        },
        async () => ({ apply: async () => "applied" }),
      ),
    ]);

    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("applied");
    expect((await command(fixture.commandId)).applicationError).toMatchObject({
      classification: "exhausted",
      deferredSince,
    });
  });

  it("bounds repeated agent teardown deferrals across claims before invoking safe recovery", async () => {
    const fixture = await terminalPrompt();
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "flow_node_attempt",
        async () => {
          throw new PromptOwnerDeferred("agent_session_teardown_pending");
        },
        async ({ owner }) => ({
          apply: async (tx) => {
            await tx
              .update(runs)
              .set({ status: "Failed" })
              .where(eq(runs.id, owner.ref.runId));

            return "applied";
          },
        }),
      ),
    ]);

    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("deferred");
    const deferred = await command(fixture.commandId);

    expect(deferred.applicationAttempts).toBe(0);
    expect(deferred.applicationError?.deferredSince).toBeDefined();
    await db
      .update(executionCommands)
      .set({
        applicationNextRetryAt: null,
        applicationError: {
          ...deferred.applicationError!,
          deferredSince: new Date(Date.now() - 180_000).toISOString(),
        },
      })
      .where(eq(executionCommands.id, fixture.commandId));
    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("applied");
    expect((await command(fixture.commandId)).applicationError).toMatchObject({
      reason: "prompt_owner_application_failed",
      classification: "exhausted",
      causeDetails: { causeCode: "agent_session_teardown_pending" },
    });
  });

  it("preserves the original PRECONDITION reason, details and stage after exhausted retry", async () => {
    const fixture = await terminalPrompt();
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("flow_node_attempt", async ({ onProgress }) => {
        onProgress?.("result_publication");
        throw new MaisterError(
          "PRECONDITION",
          "Publication requires an immutable result",
          {
            details: {
              reason: "result_digest_missing",
              resultId: "result-42",
              token: "private-value",
            },
          },
        );
      }),
    ]);

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        await applyPromptOwner({
          db,
          owners,
          ...fixture,
          signal: AbortSignal.timeout(10_000),
        }),
      ).toBe(attempt === 4 ? "poisoned" : "deferred");
      await db
        .update(executionCommands)
        .set({ applicationNextRetryAt: null })
        .where(eq(executionCommands.id, fixture.commandId));
    }
    const row = await command(fixture.commandId);

    expect(row.applicationError).toMatchObject({
      reason: "prompt_owner_poisoned",
      phase: "prepare",
      stage: "result_publication",
      causeCode: "PRECONDITION",
      causeReason: "result_digest_missing",
      causeMessage: "Publication requires an immutable result",
      causeDetails: { resultId: "result-42" },
    });
    expect(JSON.stringify(row.applicationError)).not.toContain("private-value");
    expect(row.completionAppliedAt).toBeNull();
  });

  it("bounds noncooperative preparation and never applies its late result", async () => {
    const fixture = await terminalPrompt();
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter("flow_node_attempt", async () => {
        await delay(100);

        return {
          apply: async (tx) => {
            await tx
              .update(runs)
              .set({ status: "Done" })
              .where(eq(runs.id, fixture.runId));

            return "applied";
          },
        };
      }),
    ]);
    const claim = await claimPromptOwner({
      db,
      owners,
      commandId: fixture.commandId,
    });

    if (!claim) throw new Error("Test prompt claim was not acquired");
    expect(
      await applyClaimedPromptOwner({
        db,
        owners,
        claim,
        signal: AbortSignal.timeout(10_000),
        prepareTimeoutMs: 20,
      }),
    ).toBe("deferred");
    await delay(150);
    expect(
      (await command(fixture.commandId)).applicationError?.causeReason,
    ).toBe("prompt_owner_prepare_timeout");
    const [run] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, fixture.runId));

    expect(run.status).toBe("Running");
    expect((await command(fixture.commandId)).completionAppliedAt).toBeNull();
  });

  it("commits invariant recovery atomically once, preserving failure evidence", async () => {
    const fixture = await terminalPrompt();
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "flow_node_attempt",
        async () => {
          throw new PromptOwnerInvariantError("result_binding_mismatch");
        },
        async ({ owner }) => ({
          apply: async (tx) => {
            await tx
              .update(runs)
              .set({ status: "Failed" })
              .where(eq(runs.id, owner.ref.runId));

            return "applied";
          },
        }),
      ),
    ]);

    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("applied");
    const row = await command(fixture.commandId);

    expect(row.applicationState).toBe("applied");
    expect(row.applicationError).toMatchObject({
      reason: "prompt_owner_application_failed",
      classification: "invariant",
      causeCode: "result_binding_mismatch",
    });
    expect(row.completionAppliedAt).not.toBeNull();
    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("deferred");
    expect((await command(fixture.commandId)).completionAppliedAt).toEqual(
      row.completionAppliedAt,
    );
  });

  it("keeps the original error when safe failure finalization cannot establish quiescence", async () => {
    const fixture = await terminalPrompt();
    const owners = createPromptOwnerRegistry([
      definePromptOwnerAdapter(
        "flow_node_attempt",
        async () => {
          throw new PromptOwnerInvariantError("result_binding_mismatch");
        },
        async () => {
          throw new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "Execution exit has not been proven",
            { details: { reason: "execution_quiescence_unproven" } },
          );
        },
      ),
    ]);

    expect(
      await applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("poisoned");
    expect((await command(fixture.commandId)).applicationError).toMatchObject({
      causeCode: "result_binding_mismatch",
      recoveryError: {
        code: "EXECUTOR_UNAVAILABLE",
        reason: "execution_quiescence_unproven",
      },
    });
    expect((await command(fixture.commandId)).completionAppliedAt).toBeNull();
  });

  it("recovers an expired claim after restart and fences competing workers", async () => {
    const fixture = await terminalPrompt();
    const owners = successOwners();
    const staleClaim = await claimPromptOwner({
      db,
      owners,
      commandId: fixture.commandId,
    });

    if (!staleClaim) throw new Error("Test prompt claim was not acquired");
    await db
      .update(executionCommands)
      .set({
        applicationClaimExpiresAt: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(executionCommands.id, fixture.commandId));
    const results = await Promise.all([
      applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
      applyPromptOwner({
        db,
        owners,
        ...fixture,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    expect(results.filter((result) => result === "applied")).toHaveLength(1);
    expect(
      await applyClaimedPromptOwner({
        db,
        owners,
        claim: staleClaim,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("deferred");
    expect((await command(fixture.commandId)).applicationState).toBe("applied");
  });

  it("rearms only the observed unclaimed terminal command and retains original diagnostics", async () => {
    const fixture = await terminalPrompt();

    await db
      .update(executionCommands)
      .set({
        applicationState: "poisoned",
        applicationAttempts: 5,
        applicationError: {
          reason: "prompt_owner_poisoned",
          phase: "prepare",
          causeCode: "PRECONDITION",
          causeReason: "command_in_progress",
          stage: "output",
        },
      })
      .where(eq(executionCommands.id, fixture.commandId));
    const observed = await inspectPromptApplication(db, fixture.commandId);
    const results = await Promise.allSettled([
      rearmPromptApplication({
        db,
        commandId: fixture.commandId,
        expectedToken: observed.observationToken,
      }),
      rearmPromptApplication({
        db,
        commandId: fixture.commandId,
        expectedToken: observed.observationToken,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect((await command(fixture.commandId)).applicationError).toMatchObject({
      causeReason: "command_in_progress",
      stage: "output",
      previousAttempts: 5,
    });
    const owners = successOwners();
    const claim = await claimPromptOwner({
      db,
      owners,
      commandId: fixture.commandId,
    });
    const live = await inspectPromptApplication(db, fixture.commandId);

    expect(claim).not.toBeNull();
    await expect(
      rearmPromptApplication({
        db,
        commandId: fixture.commandId,
        expectedToken: live.observationToken,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "prompt_application_claim_live" },
    });
  });
});
