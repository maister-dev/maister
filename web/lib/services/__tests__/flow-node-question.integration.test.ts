import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql, eq, and } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  nodeAttempts,
  runs,
  hitlRequests,
  users,
  projectMembers,
  assignments,
  projectTokens,
  executionEvents,
  executionCommands,
  runSessionIncarnations,
} from "@/lib/db/schema";
import {
  requestFlowNodeQuestion,
  activateFlowNodeQuestionOnHostEvents,
  reconcileFlowNodeQuestion,
  recoverFlowNodeQuestions,
  settleFlowNodeQuestionWait,
} from "@/lib/services/flow-node-question";
import {
  answerFlowNodeQuestion,
  currentFlowNodeAnswer,
} from "@/lib/services/flow-node-answer";
import {
  projectCommittedFlowNodeAnswers,
  recoverPersistedFlowNodeAnswers,
} from "@/lib/db/flow-node-answer-delivery";
import { markNodeSucceeded } from "@/lib/flows/graph/ledger";
import { closeFlowNodeQuestions } from "@/lib/runs/flow-question-lifecycle";
import { admitNodePrompt } from "@/lib/flows/graph/node-prompt-owner";
import { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";
import { respondToHitl } from "@/lib/services/hitl";
import {
  abandonRunInTransaction,
  markResumed,
} from "@/lib/runs/state-transitions";
import { issueFlowQuestionNodeToken } from "@/lib/agents/tokens";
import { captureFlowQuestionSource } from "@/lib/execution-host/flow-question-source";
import { markHostReadiness, retireHost } from "@/lib/execution-host/hosts";
import { executionHosts as registeredHosts } from "@/lib/db/schema";
import { runPass2 } from "@/lib/runs/keepalive-sweeper";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
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
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  getHitlInbox,
  getHitlRequestsForRun,
  projectQuestionForm,
} from "@/lib/queries/hitl";
import { seedNodePromptOwner } from "@/test-support/prompt-owner-fixture";

let database: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_node_question",
  });
  db = database.db;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("IT-ASK-03 / IT-ASK-04 / IT-EDGE-ASK-04 recovers both sibling answers from their exact checkpoint witnesses", async () => {
  const fake = createFakeExecutionHost();
  const projectId = await seedProject(database.db);

  await seedLocalHost(database.db, fake.identity);
  const runId = await seedRun(database.db, {
    projectId,
    status: "Running",
    runKind: "flow",
    executionDataPlaneMode: "canonical_events_v1",
  });

  await seedWorkspace(database.db, {
    runId,
    projectId,
    worktreePath: "/tmp/flow-ask/work",
    parentRepoPath: "/tmp/flow-ask",
  });
  const installed = await fakeExecutionHosts(db, { fake, runId });
  const client = await installed.hosts.forAssignment(installed.assignment!);
  const hold = Promise.withResolvers<{ stopReason: "end_turn"; meta: null }>();

  const independent = Promise.withResolvers<{
    stopReason: "end_turn";
    meta: null;
  }>();

  fake.setPromptBehavior(({ envelope }) =>
    envelope.payload.stepId === "audit" ? independent.promise : hold.promise,
  );
  try {
    for (const stepId of ["design", "audit", "review"]) {
      const session = await client.createSession({
        stepId,
        sessionName: stepId,
        executor: { agent: "claude", model: "mock" },
      });

      await client.prompt(
        session.hostSessionId,
        { stepId, prompt: "Choose a path" },
        {
          admitOwner: await seedNodePromptOwner(
            db,
            client,
            session.hostSessionId,
            { stepId },
          ),
        },
      );
    }
    await db
      .update(runs)
      .set({ currentStepId: "review" })
      .where(eq(runs.id, runId));
    const attempts = await db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, runId));
    const design = attempts.find((row) => row.nodeId === "design")!;
    const source = await db.transaction((tx) =>
      captureFlowQuestionSource(tx, runId, design.id),
    );

    expect(source.flowQuestion.nodeAttemptId).toBe(design.id);
    const [human] = await db
      .insert(users)
      .values({ email: "answerer@example.test", accountStatus: "active" })
      .returning();

    await db
      .insert(projectMembers)
      .values({ projectId, userId: human.id, role: "member" });
    const ask = async (attemptId: string) => {
      const token = await issueFlowQuestionNodeToken({
        projectId,
        runId,
        nodeAttemptId: attemptId,
        agentId: "test-designer",
        assignmentId: client.assignment.id,
        promptOrdinal: 0,
        db,
      });
      const input = {
        requestKey: "path",
        question: "Which path?",
        schema: {
          schemaVersion: 1 as const,
          fields: [{ name: "path", type: "string" as const, required: true }],
        },
      };
      const receipt = await requestFlowNodeQuestion(db, token.tokenId, input);

      expect(await requestFlowNodeQuestion(db, token.tokenId, input)).toEqual(
        receipt,
      );
      await expect(
        requestFlowNodeQuestion(db, token.tokenId, {
          ...input,
          question: "Other?",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      return receipt.questionId;
    };
    const stale = await issueFlowQuestionNodeToken({
      projectId,
      runId,
      nodeAttemptId: design.id,
      agentId: "test-designer",
      assignmentId: client.assignment.id,
      promptOrdinal: 1,
      db,
    });

    await expect(
      requestFlowNodeQuestion(db, stale.tokenId, {
        requestKey: "stale",
        question: "May I proceed?",
        schema: {
          schemaVersion: 1,
          fields: [{ name: "answer", type: "string", required: true }],
        },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const stepQuestion = await ask(design.id);

    expect(await getHitlRequestsForRun(runId, projectId, { db })).toEqual([]);
    const rollbackWitness = new Error("discard test branch");

    // Inspect receipt recovery in a savepoint while leaving both real ACP turns live.
    for (const race of ["rejected-checkpoint", "replaced"] as const) {
      await expect(
        db.transaction(async (tx) => {
          const [question] = await tx
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.id, stepQuestion));
          const op = await client.prepareQuestionCheckpoint(
            tx,
            source.supervisorSessionId,
            null,
          );

          await tx
            .update(executionCommands)
            .set({ state: "failed", completedAt: new Date() })
            .where(eq(executionCommands.id, op.commandId));
          await tx
            .update(hitlRequests)
            .set({
              schema: {
                ...(question.schema as object),
                checkpointCommandId: op.commandId,
              },
            })
            .where(eq(hitlRequests.id, stepQuestion));
          if (race === "replaced")
            await tx.insert(nodeAttempts).values({
              id: randomUUID(),
              runId,
              nodeId: design.nodeId,
              nodeType: "ai_coding",
              status: "Running",
              attempt: design.attempt + 1,
            });
          expect(await recoverFlowNodeQuestions(tx, installed.hosts)).toBe(0);
          expect(
            (
              await tx
                .select()
                .from(hitlRequests)
                .where(eq(hitlRequests.id, stepQuestion))
            )[0].activationState,
          ).toBe("failed");
          if (race === "rejected-checkpoint")
            expect(
              (
                await tx
                  .select()
                  .from(nodeAttempts)
                  .where(eq(nodeAttempts.id, design.id))
              )[0].status,
            ).toBe("Running");
          expect(
            await tx
              .select()
              .from(assignments)
              .where(eq(assignments.hitlRequestId, stepQuestion)),
          ).toHaveLength(0);
          throw rollbackWitness;
        }),
      ).rejects.toBe(rollbackWitness);
    }
    fake.loseResponseOnce("checkpointSession");
    expect(
      await db
        .select()
        .from(assignments)
        .where(eq(assignments.hitlRequestId, stepQuestion)),
    ).toHaveLength(0);
    await activateFlowNodeQuestionOnHostEvents(
      db,
      installed.hosts,
      stepQuestion,
    );
    expect(
      (
        await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, stepQuestion))
      )[0].activationState,
    ).toBe("active");
    expect(
      (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
    ).toBe("Running");
    expect(
      await db
        .select({ id: projectTokens.id })
        .from(projectTokens)
        .where(
          and(
            eq(projectTokens.knowledge_node_attempt_id, design.id),
            sql`${projectTokens.revoked_at} IS NULL`,
          ),
        ),
    ).toEqual([]);
    const visible = await getHitlRequestsForRun(runId, projectId, { db });

    expect(visible.map((row) => row.id)).toEqual([stepQuestion]);
    expect(
      Object.keys(
        projectQuestionForm("agent_question", visible[0].schema) as object,
      ).sort(),
    ).toEqual(["fields", "requestingAgent", "schemaVersion"]);
    const review = attempts.find((row) => row.nodeId === "review")!;
    const inbox = await getHitlInbox(projectId, {
      db,
      recipient: { kind: "user", userId: human.id },
    });

    expect(
      inbox.items.find((item) => item.hitlRequestId === stepQuestion),
    ).toMatchObject({ runId, prompt: "Which path?", assignmentStatus: "open" });
    const reviewQuestion = await ask(review.id);

    await expect
      .poll(async () => {
        await reconcileFlowNodeQuestion(db, installed.hosts, reviewQuestion);

        return (
          await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.id, reviewQuestion))
        )[0].activationState;
      })
      .toBe("active");
    expect(
      (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
    ).toBe("Running");
    const audit = attempts.find((row) => row.nodeId === "audit")!;
    const sibling = await db.transaction((tx) =>
      captureFlowQuestionSource(tx, runId, audit.id),
    );

    independent.resolve({ stopReason: "end_turn", meta: null });
    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(executionCommands)
              .where(eq(executionCommands.id, sibling.flowQuestion.commandId))
          )[0],
      )
      .toMatchObject({
        state: "succeeded",
        terminalEventId: expect.any(String),
      });
    await client.deleteSession(sibling.supervisorSessionId);
    await fake.waitForCanonicalEvents();
    await markNodeSucceeded(audit.id, {}, db);
    expect(
      await db.transaction((tx) =>
        settleFlowNodeQuestionWait(tx, runId, client.assignment.id),
      ),
    ).toBe(true);
    expect(
      (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
    ).toBe("NeedsInputIdle");
    await expect(
      answerFlowNodeQuestion(db, runId, reviewQuestion, human.id, {}),
    ).rejects.toMatchObject({ code: "NEEDS_INPUT" });
    await db
      .update(projectMembers)
      .set({ role: "viewer" })
      .where(eq(projectMembers.userId, human.id));
    await expect(
      answerFlowNodeQuestion(db, runId, reviewQuestion, human.id, {
        path: "cart",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await db
      .update(projectMembers)
      .set({ role: "member" })
      .where(eq(projectMembers.userId, human.id));
    const [reviewAnswer, otherSurface] = await Promise.all([
      answerFlowNodeQuestion(db, runId, reviewQuestion, human.id, {
        path: "cart",
      }),
      respondToHitl(
        {
          runId,
          hitlRequestId: reviewQuestion,
          body: { response: { path: "cart" } },
        },
        {
          kind: "user",
          userId: human.id,
          label: "Answerer",
          preauthorizedProjectId: projectId,
        },
        { db, executionHosts: installed.hosts },
      ),
    ]);

    expect(otherSurface.status).toBe(202);
    expect(await otherSurface.json()).toMatchObject(reviewAnswer.receipt);
    expect(reviewAnswer).toMatchObject({
      status: 202,
      receipt: { state: "accepted" },
    });
    expect(
      await answerFlowNodeQuestion(db, runId, reviewQuestion, human.id, {
        path: "cart",
      }),
    ).toEqual(reviewAnswer);
    await expect(
      answerFlowNodeQuestion(db, runId, reviewQuestion, human.id, {
        path: "payment",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const refusal of [
      "responder revoked",
      "source host retired",
      "source host offline",
    ] as const) {
      await expect(
        db.transaction(async (tx) => {
          if (refusal === "responder revoked")
            await tx
              .update(projectMembers)
              .set({ role: "viewer" })
              .where(eq(projectMembers.userId, human.id));
          else if (refusal === "source host retired") {
            await retireHost(tx, installed.host.id);
            await expect(
              markResumed(runId, {
                db: tx,
                placement: { host: installed.host, transport: fake.transport },
              }),
            ).rejects.toMatchObject({
              code: "CONFLICT",
              details: { reason: "node_question_checkpoint_unavailable" },
            });
          } else {
            await markHostReadiness(
              tx,
              installed.host.id,
              "unavailable",
              "network",
            );
            await recoverFlowNodeQuestions(tx, installed.hosts);
            expect(
              (await tx.select().from(runs).where(eq(runs.id, runId)))[0]
                .resumeRequestedAt,
            ).toBeInstanceOf(Date);
            await tx
              .update(registeredHosts)
              .set({ lastSeenAt: new Date(0) })
              .where(eq(registeredHosts.id, installed.host.id));
            await tx
              .update(hitlRequests)
              .set({ flowAnswerAcceptedAt: new Date(0) })
              .where(eq(hitlRequests.id, reviewQuestion));
          }

          await recoverFlowNodeQuestions(tx, installed.hosts);
          const [waiting] = await tx
            .select()
            .from(runs)
            .where(eq(runs.id, runId));
          const [accepted] = await tx
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.id, reviewQuestion));

          expect(waiting.resumeRequestedAt).toBeNull();
          expect(accepted).toMatchObject({
            response: { path: "cart" },
            flowAnswerUserId: human.id,
            flowAnswerAcceptedAt: expect.any(Date),
            respondedAt: null,
            supersededAt: null,
          });
          if (refusal === "responder revoked") {
            await tx
              .update(projectMembers)
              .set({ role: "member" })
              .where(eq(projectMembers.userId, human.id));
            await recoverFlowNodeQuestions(tx, installed.hosts);
            expect(
              (await tx.select().from(runs).where(eq(runs.id, runId)))[0],
            ).toMatchObject({
              currentStepId: "review",
              resumeRequestedAt: expect.any(Date),
            });
          } else {
            await tx
              .update(runs)
              .set({ checkpointAt: new Date(0) })
              .where(eq(runs.id, runId));
            expect(await runPass2(tx)).toBe(1);
            expect(
              (
                await tx
                  .select()
                  .from(hitlRequests)
                  .where(eq(hitlRequests.id, reviewQuestion))
              )[0],
            ).toMatchObject({
              response: { path: "cart" },
              flowAnswerUserId: human.id,
              flowAnswerAcceptedAt: accepted.flowAnswerAcceptedAt,
              respondedAt: null,
              supersededAt: expect.any(Date),
            });
          }
          throw rollbackWitness;
        }),
      ).rejects.toBe(rollbackWitness);
    }
    const [designer] = await db
      .insert(users)
      .values({ email: "designer@example.test", accountStatus: "active" })
      .returning();

    await db
      .insert(projectMembers)
      .values({ projectId, userId: designer.id, role: "member" });
    await answerFlowNodeQuestion(db, runId, stepQuestion, designer.id, {
      path: "payment",
    });
    expect(
      (await db.select().from(runs).where(eq(runs.id, runId)))[0].currentStepId,
    ).toBe("review");
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(projectMembers)
          .set({ role: "viewer" })
          .where(eq(projectMembers.userId, human.id));
        await recoverFlowNodeQuestions(tx, installed.hosts);
        expect(
          (await tx.select().from(runs).where(eq(runs.id, runId)))[0]
            .currentStepId,
        ).toBe("design");
        throw rollbackWitness;
      }),
    ).rejects.toBe(rollbackWitness);
    // Inspect alternate terminal/replacement races at this same committed checkpoint.

    for (const race of ["abandon", "replace"] as const) {
      await expect(
        db.transaction(async (tx) => {
          if (race === "abandon")
            expect(await abandonRunInTransaction(tx, runId)).toBe(true);
          else
            await tx.insert(nodeAttempts).values({
              id: randomUUID(),
              runId,
              nodeId: review.nodeId,
              nodeType: "ai_coding",
              status: "Running",
              attempt: review.attempt + 1,
            });
          const denied = await respondToHitl(
            {
              runId,
              hitlRequestId: reviewQuestion,
              body: { response: { path: "cart" } },
            },
            {
              kind: "user",
              userId: human.id,
              label: "Answerer",
              preauthorizedProjectId: projectId,
            },
            { db: tx, executionHosts: installed.hosts },
          );

          expect(denied.status).toBe(410);
          expect(
            (await getHitlRequestsForRun(runId, projectId, { db: tx })).some(
              (row) => row.id === reviewQuestion,
            ),
          ).toBe(false);
          throw rollbackWitness;
        }),
      ).rejects.toBe(rollbackWitness);
    }
    fake.restart();
    const claimed = await markResumed(runId, {
      db,
      placement: { host: installed.host, transport: fake.transport },
    });

    expect(claimed.ok).toBe(true);
    expect(
      (
        await db.transaction((tx) =>
          currentFlowNodeAnswer(tx, runId, review.id),
        )
      )?.question.response,
    ).toEqual({ path: "cart" });
    await expect(
      db.transaction((tx) => currentFlowNodeAnswer(tx, runId, design.id)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const checkpoints = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.checkpoint"),
        ),
      );

    expect(checkpoints).toHaveLength(2);
    await projectCommittedFlowNodeAnswers(db, runId, [
      source.flowQuestion.commandId,
    ]);
    expect(
      (
        await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, stepQuestion))
      )[0].respondedAt,
    ).toBeNull();
    fake.setPromptBehavior(async () => ({
      stopReason: "end_turn",
      meta: null,
    }));
    for (const [target, qid, path] of [
      [review, reviewQuestion, "cart"],
      [design, stepQuestion, "payment"],
    ] as const) {
      const fresh =
        target.id === review.id
          ? claimed
          : await markResumed(runId, {
              db,
              placement: { host: installed.host, transport: fake.transport },
            });

      if (!fresh.ok || !fresh.assignment)
        throw new Error("missing admitted question generation");
      const nextClient = await installed.hosts.forAssignment(fresh.assignment);
      const answer = await db.transaction((tx) =>
        currentFlowNodeAnswer(tx, runId, target.id),
      );
      const resume = answer?.attempt.actionResume;

      if (resume?.kind !== "node_question")
        throw new Error("missing question owner");
      expect(answer?.question.response).toEqual({ path });
      // The normal graph owner advances its claimed visit before dispatching.
      await db
        .update(runs)
        .set({ status: "Running" })
        .where(eq(runs.id, runId));
      await db
        .update(nodeAttempts)
        .set({ status: "Running" })
        .where(eq(nodeAttempts.id, target.id));
      const next = await nextClient.createSession({
        stepId: target.nodeId,
        sessionName: target.nodeId,
        executor: { agent: "claude", model: "mock" },
        resumeSessionId: resume.resumeSessionId,
      });

      expect(next.acpSessionId).toBe(resume.resumeSessionId);
      await waitForPromptIncarnation(db, nextClient, next.hostSessionId);
      const prompt = {
        stepId: target.nodeId,
        prompt: JSON.stringify(answer?.question.response),
      };
      const options = {
        admitOwner: (tx: Parameters<typeof admitNodePrompt>[0]) =>
          admitNodePrompt(tx, nextClient, next.hostSessionId, {
            variant: "node",
            nodeAttemptId: target.id,
            promptOrdinal: resume.promptOrdinal,
          }),
      };

      if (qid === stepQuestion) {
        await db.execute(sql`CREATE FUNCTION block_test_node_answer_delivery() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN
            IF OLD.responded_at IS NULL AND NEW.responded_at IS NOT NULL THEN
              RAISE EXCEPTION 'test answer projection unavailable';
            END IF;
            RETURN NEW;
          END $$`);
        await db.execute(sql`CREATE TRIGGER block_test_node_answer_delivery
          BEFORE UPDATE ON hitl_requests FOR EACH ROW EXECUTE FUNCTION block_test_node_answer_delivery()`);
        try {
          fake.loseResponseOnce("startPrompt");
          const successor = await nextClient.prompt(
            next.hostSessionId,
            prompt,
            options,
          );
          const [command] = await db
            .select()
            .from(executionCommands)
            .where(eq(executionCommands.id, successor.commandId));

          expect(command.acceptedAt).toBeInstanceOf(Date);
          await fake.waitForCanonicalEvents();
          await db.transaction(async (tx) => {
            await tx
              .select({ id: runs.id })
              .from(runs)
              .where(eq(runs.id, runId))
              .for("no key update");
            await closeFlowNodeQuestions(tx, runId, "test terminal closure");
          });
          const [undelivered] = await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.id, qid));

          expect(undelivered.respondedAt).toBeNull();
          expect(undelivered.supersededAt).toBeNull();
          await db
            .update(nodeAttempts)
            .set({ actionResume: null })
            .where(eq(nodeAttempts.id, target.id));
        } finally {
          await db.execute(
            sql`DROP TRIGGER block_test_node_answer_delivery ON hitl_requests`,
          );
          await db.execute(
            sql`DROP FUNCTION block_test_node_answer_delivery()`,
          );
        }
        await expect(recoverPersistedFlowNodeAnswers(db)).resolves.toBe(1);
      } else {
        fake.loseResponseOnce("startPrompt");
        await nextClient.prompt(next.hostSessionId, prompt, options);
      }
      await expect
        .poll(
          async () =>
            (
              await db
                .select()
                .from(hitlRequests)
                .where(eq(hitlRequests.id, qid))
            )[0].respondedAt,
        )
        .not.toBeNull();
      const replay = await answerFlowNodeQuestion(
        db,
        runId,
        qid,
        target.id === review.id ? human.id : designer.id,
        {
          path,
        },
      );

      expect(replay).toMatchObject({
        status: 200,
        receipt: { state: "delivered" },
      });
      const owned = await db.execute(
        sql`SELECT id FROM execution_commands WHERE owner_ref->>'nodeAttemptId'=${target.id} AND owner_ref->'promptOrdinal'='1'::jsonb AND kind='session.prompt'`,
      );

      expect(owned.rows).toHaveLength(1);
      const reconnectEvents = await db
        .select({ source: executionEvents.sourceKey })
        .from(executionEvents)
        .where(
          and(
            eq(executionEvents.runId, runId),
            sql`${executionEvents.sourceKey} LIKE ${"flow-node-question:" + qid + ":%"}`,
          ),
        )
        .orderBy(executionEvents.runSequence);

      expect(reconnectEvents.map((event) => event.source)).toEqual(
        ["opened", "accepted", "delivered"].map(
          (state) => `flow-node-question:${qid}:${state}`,
        ),
      );
      await nextClient.deleteSession(next.hostSessionId);
      await fake.waitForCanonicalEvents();
      await markNodeSucceeded(target.id, {}, db);
      if (target.id === review.id) {
        await expect
          .poll(() =>
            db.transaction((tx) =>
              settleFlowNodeQuestionWait(tx, runId, fresh.assignment!.id),
            ),
          )
          .toBe(true);
        expect(
          (await db.select().from(runs).where(eq(runs.id, runId)))[0]
            .currentStepId,
        ).toBe("design");
      }
    }
  } finally {
    independent.resolve({ stopReason: "end_turn", meta: null });
    hold.resolve({ stopReason: "end_turn", meta: null });
    await fake.waitForCanonicalEvents();
  }
});

it("waits for the exact node prompt and its live session to become durable", async () => {
  const fake = createFakeExecutionHost();
  const projectId = await seedProject(database.db);

  const runId = await seedRun(database.db, {
    projectId,
    status: "Running",
    runKind: "flow",
    executionDataPlaneMode: "canonical_events_v1",
  });

  await seedWorkspace(database.db, {
    runId,
    projectId,
    worktreePath: "/tmp/flow-ask-pending/work",
    parentRepoPath: "/tmp/flow-ask-pending",
  });
  const installed = await fakeExecutionHosts(db, { fake, runId });
  const client = await installed.hosts.forAssignment(installed.assignment!);
  const stepId = "design";

  fake.holdIngest();
  const session = await client.createSession({
    stepId,
    sessionName: stepId,
    executor: { agent: "claude", model: "mock" },
  });
  const admitOwner = await seedNodePromptOwner(
    db,
    client,
    session.hostSessionId,
    {
      stepId,
    },
  );
  const { owner } = await admitOwner(db);

  if (owner.kind !== "flow_node_attempt")
    throw new Error("Expected a Flow node prompt owner");
  const { nodeAttemptId } = owner.ref;
  const issueToken = () =>
    issueFlowQuestionNodeToken({
      projectId,
      runId,
      nodeAttemptId,
      agentId: "test-designer",
      assignmentId: client.assignment.id,
      promptOrdinal: 0,
      db,
    });
  const token = await issueToken();
  const input = {
    requestKey: "path",
    question: "Which path?",
    schema: {
      schemaVersion: 1 as const,
      fields: [{ name: "path", type: "string" as const, required: true }],
    },
  };
  const deliveryStarted = Promise.withResolvers<void>();
  const releaseAcceptance = Promise.withResolvers<void>();
  const completePrompt = Promise.withResolvers<{
    stopReason: "end_turn";
    meta: null;
  }>();
  const removeHook = fake.onCall("startPrompt", async () => {
    deliveryStarted.resolve();
    await releaseAcceptance.promise;
  });
  const cancel = new AbortController();

  fake.setPromptBehavior(() => completePrompt.promise);
  const delivery = client.prompt(
    session.hostSessionId,
    { stepId, prompt: "Choose a path" },
    { admitOwner },
  );

  try {
    await Promise.race([deliveryStarted.promise, delivery]);
    const commandId = fake.callsOf("startPrompt")[0].envelope!.command.id;
    const readCommand = () =>
      db
        .select({ state: executionCommands.state })
        .from(executionCommands)
        .where(eq(executionCommands.id, commandId));
    const questions = () =>
      db.select().from(hitlRequests).where(eq(hitlRequests.runId, runId));

    expect(await readCommand()).toEqual([{ state: "delivering" }]);
    const expectWaiting = async (asking: Promise<unknown>): Promise<void> => {
      await expect(
        Promise.race([
          asking.then(() => "settled"),
          vi
            .waitFor(() => expect(runEventWakeBus.waiterCount(runId)).toBe(1))
            .then(() => "waiting"),
        ]),
      ).resolves.toBe("waiting");
    };
    const revoked = requestFlowNodeQuestion(
      db,
      token.tokenId,
      input,
      cancel.signal,
    );

    await expectWaiting(revoked);
    const current = await issueToken();

    // Credential rotation commits without a process-local Run wake.
    await expect(revoked).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const asking = requestFlowNodeQuestion(
      db,
      current.tokenId,
      input,
      cancel.signal,
    );

    await expectWaiting(asking);
    expect(await questions()).toEqual([]);
    releaseAcceptance.resolve();
    await delivery;
    expect(await readCommand()).toEqual([{ state: "accepted" }]);
    expect(
      await db
        .select({ state: runSessionIncarnations.state })
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.id, owner.ref.incarnationId)),
    ).toEqual([{ state: "created" }]);
    await expectWaiting(asking);
    await expect(asking).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "flow_question_prompt_acceptance_pending" },
    });
    expect(runEventWakeBus.waiterCount(runId)).toBe(0);
    expect(await questions()).toEqual([]);
    const retry = requestFlowNodeQuestion(
      db,
      current.tokenId,
      input,
      cancel.signal,
    );

    await expectWaiting(retry);
    await fake.releaseIngest();
    const receipt = await retry;
    const [question] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, receipt.questionId));

    expect(receipt.state).toBe("checkpoint_pending");
    expect(question.schema).toMatchObject({
      supervisorSessionId: session.hostSessionId,
      flowQuestion: { commandId, nodeAttemptId, promptOrdinal: 0 },
    });
    expect(runEventWakeBus.waiterCount(runId)).toBe(0);
  } finally {
    cancel.abort();
    releaseAcceptance.resolve();
    completePrompt.resolve({ stopReason: "end_turn", meta: null });
    removeHook();
    await delivery;
    await fake.releaseIngest();
    await fake.waitForCanonicalEvents();
  }
});

it("IT-ASK-MIGRATE preserves live and historical legacy questions and the specialist protection during the upgrade", async () => {
  const cutoff = "0405_librarian_private_questions";
  const prior = await startMainPostgresTestDbUpTo(
    { databaseName: "flow_question_upgrade" },
    cutoff,
  );

  try {
    await declareCurrentTestDatabaseWriter(prior);
    const projectId = await seedProject(prior.db);
    const runId = await seedRun(prior.db, {
      projectId,
      status: "Running",
      runKind: "flow",
    });
    const taskId = randomUUID(),
      open = randomUUID(),
      closed = randomUUID();

    await prior.db.execute(
      sql`INSERT INTO tasks(id,project_id,number,title,prompt) VALUES(${taskId},${projectId},1,'request','review')`,
    );
    await prior.db
      .execute(sql`INSERT INTO hitl_requests(id,run_id,step_id,kind,prompt,schema,task_id,activation_state,retrigger_mode,responded_at,response)
      VALUES (${open},${runId},'design','agent_question','pick','{}',${taskId},'pending_termination','agent',NULL,NULL),
        (${closed},${runId},'review','agent_question','picked','{}',${taskId},'active','triage',now(),'{"choice":"A"}')`);
    const read = () =>
      prior.pool.query(
        "SELECT id,run_id,prompt,schema,activation_state,response,responded_at,task_id FROM hitl_requests ORDER BY id",
      );
    const trigger = () =>
      prior.pool.query(
        "SELECT pg_get_functiondef('guard_specialist_question_subject()'::regprocedure) AS definition",
      );
    const [before, guard] = await Promise.all([read(), trigger()]);

    await upgradeMainTestDb(prior, cutoff);
    expect((await read()).rows).toEqual(before.rows);
    expect((await trigger()).rows).toEqual(guard.rows);
    expect(
      (await prior.db.select().from(hitlRequests)).every(
        (row) =>
          row.flowNodeAttemptId === null && row.flowAnswerAcceptedAt === null,
      ),
    ).toBe(true);
    await expect(
      prior.pool.query(
        "UPDATE hitl_requests SET flow_request_key='forged' WHERE id=$1",
        [open],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "hitl_flow_question_shape_check",
    });
  } finally {
    await prior.stop();
  }
}, 180_000);
