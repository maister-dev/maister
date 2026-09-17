// TRC-05 + EDGE-TRC-04: every prompt the FLOW GRAPH DRIVER dispatches is
// recorded. A standalone agent run (`run_kind='agent'`) is out of scope — it
// dispatches through `lib/agents/launch.ts`, which records no `run_messages`
// row — so nothing here should be read as covering that path.
//
// `node_attempts.resolved_prompt` keeps at most ONE prompt per attempt, behind
// two restrictions that together hide most of what a run was actually told:
// an owner filter that admits only `node` / `permission_resume` (so `gate_ai`,
// `gate_skill` and both consensus variants are never captured at all), and a
// `WHERE resolved_prompt IS NULL` write-once guard (so a second dispatch into
// the same attempt is dropped).
//
// Two levels are pinned here, because the requirement has two halves. The
// flow-level case proves the DISPATCHER records unconditionally — a real run
// whose node carries a blocking gate must leave two `user` rows on one attempt,
// which is exactly what the filter and the guard each used to prevent. The
// store-level case proves COVERAGE of all six owner variants without paying for
// six end-to-end flows.

import type { ExecutionHosts } from "@/lib/execution-host";

import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { recordDispatchedPrompt } from "@/lib/flows/graph/prompt-record";
import { runFlow } from "@/lib/flows/runner";
import {
  getRunNodeTranscript,
  projectRunTranscript,
} from "@/lib/runs/run-transcript-projector";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test_prompt_record",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

const COMPAT = { engine_min: "2.2.0" };

function seedGraphRun(manifest: unknown): Promise<SeededGraphRun> {
  return seedGraphRunShared(db, manifest, {
    flowRevision: true,
    task: { prompt: "fix the bug" },
  });
}

async function userMessages(runId: string) {
  const rows = (await db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.runId, runId))
    .orderBy(asc(schema.runMessages.sequence))) as unknown as {
    role: string;
    content: string;
    promptDispatchKey: string | null;
    nodeAttemptId: string | null;
  }[];

  return rows.filter((row) => row.role === "user");
}

describe("dispatched prompt recording", () => {
  // IT-TRC-05 — the dispatcher half. One `ai_coding` node with a blocking
  // `ai_judgment` gate makes TWO dispatches against ONE node attempt: the
  // node's own prompt (`node`) and the gate's (`gate_ai`). Before this change
  // the owner filter dropped the second and the write-once guard would have
  // dropped it anyway, so a single recorded prompt is the defect's signature.
  it("IT-TRC-05: records a row per dispatch, including the gate's, within one attempt", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "Implement the widget." },
          pre_finish: {
            gates: [
              {
                id: "review",
                kind: "ai_judgment",
                mode: "blocking",
                prompt: "Judge the work.",
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const { hosts } = await fakeGraphHosts(db, seeded.runId, {
      text: '{"verdict":"pass"}',
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: hosts as ExecutionHosts,
    });

    const prompts = await userMessages(seeded.runId);

    expect(prompts).toHaveLength(2);
    expect(prompts[0].content).toContain("Implement the widget.");
    expect(prompts[1].content).toContain("Judge the work.");

    // Both belong to the SAME attempt, and each carries its own dispatch key.
    const attempts = new Set(prompts.map((p) => p.nodeAttemptId));

    expect(attempts.size).toBe(1);
    expect(new Set(prompts.map((p) => p.promptDispatchKey)).size).toBe(2);

    // The existing single-prompt disclosure is untouched (D4).
    const [attempt] = (await db
      .select()
      .from(schema.nodeAttempts)
      .where(eq(schema.nodeAttempts.runId, seeded.runId))) as unknown as {
      resolvedPrompt: string | null;
    }[];

    expect(attempt.resolvedPrompt).toContain("Implement the widget.");
  }, 180_000);

  // IT-EDGE-TRC-04 + the coverage half of IT-TRC-05. Six owner variants, one
  // node attempt, six rows — the shape the owner filter made impossible.
  it("IT-EDGE-TRC-04: records every owner variant, consensus included", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: COMPAT,
      nodes: [
        {
          id: "implement",
          type: "ai_coding",
          action: { prompt: "Implement." },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const nodeAttemptId = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId: seeded.runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    });

    const owners = [
      { variant: "node", nodeAttemptId, promptOrdinal: 0 },
      {
        variant: "permission_resume",
        nodeAttemptId,
        promptOrdinal: 1,
        hitlRequestId: "hitl-1",
      },
      {
        variant: "gate_ai",
        nodeAttemptId,
        gateId: "review",
        evaluationId: "eval-1",
        promptOrdinal: 0,
      },
      {
        variant: "gate_skill",
        nodeAttemptId,
        gateId: "lint",
        evaluationId: "eval-2",
        promptOrdinal: 0,
      },
      {
        variant: "consensus_verifier",
        nodeAttemptId,
        round: 1,
        verifierId: "v1",
        targetId: "t1",
        verdictId: "verdict-1",
      },
      {
        variant: "consensus_synthesis",
        nodeAttemptId,
        round: 1,
        synthesisId: "synthesis-1",
      },
    ] as const;

    for (const owner of owners) {
      await recordDispatchedPrompt({
        db,
        runId: seeded.runId,
        nodeAttemptId,
        stepId: "implement",
        owner,
        prompt: `prompt for ${owner.variant}`,
        contextMounts: null,
      });
    }

    const prompts = await userMessages(seeded.runId);

    expect(prompts).toHaveLength(owners.length);
    expect(prompts.map((p) => p.content)).toEqual(
      owners.map((owner) => `prompt for ${owner.variant}`),
    );
    expect(new Set(prompts.map((p) => p.promptDispatchKey)).size).toBe(
      owners.length,
    );
  }, 120_000);

  // IT-EDGE-TRC-08. The two `run_messages` writers share one counter but run
  // on different clocks: a prompt is written eagerly at dispatch, while a
  // reply is projected by the canonical worker or lazily on read — the graph
  // runner drives only the ARTIFACT projector at its sync points. The gap
  // between a node's turn ending and its gate dispatching is a few
  // milliseconds, so the reply is normally still unprojected at that moment.
  //
  // Reproduced here by ingesting the reply event WITHOUT projecting it, which
  // is exactly the state the runner is in. Against the undrained recorder the
  // order is `NODE-PROMPT, GATE-PROMPT, NODE-REPLY` — permanently, since
  // sequences are never rewritten. This asserts the whole conversation, not
  // just the prompts: `userMessages` filters replies out and therefore cannot
  // see the defect at all.
  it("IT-EDGE-TRC-08: keeps causal order when a reply is still unprojected", async () => {
    const projectId = randomUUID();
    const runId = randomUUID();
    const nodeAttemptId = randomUUID();
    const slug = `order-${projectId.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id: projectId,
      taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
      slug,
      name: slug,
      repoPath: `/tmp/${slug}`,
      maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    } as never);
    await db.insert(schema.runs).values({
      id: runId,
      projectId,
      runKind: "flow",
      status: "Running",
      executionDataPlaneMode: "canonical_events_v1",
      flowVersion: "v1",
      flowRevision: "manual",
    } as never);
    await db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    } as never);

    await recordDispatchedPrompt({
      db,
      runId,
      nodeAttemptId,
      stepId: "implement",
      owner: { variant: "node", nodeAttemptId, promptOrdinal: 0 },
      prompt: "NODE-PROMPT",
      contextMounts: null,
    });

    await db.insert(schema.executionEvents).values({
      id: randomUUID(),
      source: "manager",
      sourceKey: "prompt-order:0",
      runId,
      eventType: "session.update",
      payloadSchema: "maister.session.update.v1",
      payload: {
        nodeAttemptId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "NODE-REPLY" },
        },
      },
      occurredAt: new Date(),
      receivedAt: new Date(),
      runSequence: BigInt(0),
      ingestDisposition: "accepted",
    } as never);

    await recordDispatchedPrompt({
      db,
      runId,
      nodeAttemptId,
      stepId: "implement-gate",
      owner: {
        variant: "gate_ai",
        nodeAttemptId,
        gateId: "review",
        evaluationId: "eval-1",
        promptOrdinal: 0,
      },
      prompt: "GATE-PROMPT",
      contextMounts: null,
    });

    // The canonical worker catching up ARBITRARILY late — after BOTH prompts.
    // This is the whole point of anchoring: the reply takes the highest
    // `sequence` of the three, so any reader ordering on arrival gets it last.
    // Only the event-stream anchor can still place it in the middle.
    await projectRunTranscript(runId, { client: db as never });

    // Read through the REAL reader, not raw SQL: the ordering is the thing
    // under test, and asserting it against a query written here would prove
    // only that this test can sort.
    const transcript = await getRunNodeTranscript(runId, "implement", {
      client: db as never,
    });
    const rows = transcript?.messages ?? [];
    const positionOf = (needle: string): number =>
      rows.findIndex((row) => row.content.includes(needle));

    // Each marker is present exactly once and they read in causal order.
    for (const marker of ["NODE-PROMPT", "NODE-REPLY", "GATE-PROMPT"]) {
      expect(rows.filter((row) => row.content.includes(marker))).toHaveLength(
        1,
      );
    }
    expect(positionOf("NODE-PROMPT")).toBeLessThan(positionOf("NODE-REPLY"));
    expect(positionOf("NODE-REPLY")).toBeLessThan(positionOf("GATE-PROMPT"));

    // The defect this replaces was invisible to arrival order, so pin that the
    // reply really did arrive LAST — otherwise a future change that restores
    // eager projection would make this test pass for the wrong reason.
    const stored = (await db
      .select()
      .from(schema.runMessages)
      .where(eq(schema.runMessages.runId, runId))
      .orderBy(asc(schema.runMessages.sequence))) as unknown as {
      content: string;
    }[];

    expect(stored[stored.length - 1].content).toContain("NODE-REPLY");
  }, 120_000);
});
