// CT-TRC-11 (second seam). The internal transcript route is gated on
// `readRepoFiles`; this endpoint family admits a project-bound `runs:read`
// token and nothing more. A resolved prompt can carry injected artifact bodies
// through `{{ artifacts.<id>.content }}` (ADR-120), so serving one here would
// be a strictly wider exposure than `node_attempts.resolved_prompt` already
// crosses — exactly what TRC-11 forbids.
//
// The predicate under test keys on `prompt_dispatch_key`, never on `role`, so
// both arms are pinned: a dispatcher-recorded prompt must NOT appear, and a
// scratch run's own `user` dialog — an untagged row a real operator produced —
// MUST still appear. A role-based filter would pass the first assertion and
// fail the second, which is why the second one is here.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { getRunActivityResponse } from "@/lib/ext-activity/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_activity_prompt_exposure_test",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

const SECRET = "SECRET-ARTIFACT-BODY-a7f3c1d2";

async function seedRun(runKind: "flow" | "scratch") {
  const db = testDatabase.db;
  const projectId = randomUUID();
  const runId = randomUUID();
  const slug = `ext-prompt-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind,
    status: "Running",
    executionDataPlaneMode: "canonical_events_v1",
    flowVersion: "v1",
    flowRevision: "test",
  });

  return { projectId, runId };
}

/** The response carries BigInt cursors, which `JSON.stringify` refuses. */
function wireOf(response: unknown): string {
  return JSON.stringify(response, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function readActivity(projectId: string, runId: string) {
  return getRunActivityResponse(projectId, runId, {
    sinceId: null,
    limit: 100,
    // The most permissive rank — nothing is withheld by salience, so an
    // absence assertion cannot pass merely because a filter dropped the row.
    salience: "low",
    client: testDatabase.db,
  });
}

describe("external run activity never serves a recorded prompt", () => {
  it("CT-TRC-11: withholds a dispatcher-recorded prompt from a runs:read reader", async () => {
    const { projectId, runId } = await seedRun("flow");
    const nodeAttemptId = randomUUID();

    await testDatabase.db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    });
    await testDatabase.db.insert(schema.runMessages).values([
      {
        id: randomUUID(),
        runId,
        nodeAttemptId,
        sequence: 0,
        role: "user",
        content: `Implement the widget.\n\n${SECRET}`,
        promptDispatchKey: `dispatch:${nodeAttemptId}:0`,
      },
      {
        id: randomUUID(),
        runId,
        nodeAttemptId,
        sequence: 1,
        role: "assistant",
        content: "widget implemented",
        promptDispatchKey: null,
      },
    ]);

    const response = await readActivity(projectId, runId);

    expect(response).not.toBeNull();

    // Asserted over the WHOLE serialized response, not just `items`: the
    // prompt reached `action.detail` AND the snapshot's last-action summary,
    // so checking one field would leave the other as a live exposure.
    const wire = wireOf(response);

    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("Implement the widget");

    // Non-vacuous: the run's OTHER transcript row still arrives, so the
    // absence above is the predicate at work and not an empty feed.
    expect(wire).toContain("widget implemented");
  }, 60_000);

  // The predicate on the main query is not the only door. When it matches
  // nothing the reader FALLS BACK to the whole-run feed — and the state where
  // it matches nothing is precisely a flow run whose only rows so far are its
  // prompts: node dispatched, nothing projected yet. A filter on the first
  // query alone would have left this second path wide open, which is why the
  // whole-run feed refuses prompts by default rather than on request.
  it("CT-TRC-11: withholds a prompt through the empty-feed fallback too", async () => {
    const { projectId, runId } = await seedRun("flow");
    const nodeAttemptId = randomUUID();

    await testDatabase.db.insert(schema.nodeAttempts).values({
      id: nodeAttemptId,
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
    });
    // The ONLY row on the run — so the filtered query returns nothing and the
    // fallback is the path that answers.
    await testDatabase.db.insert(schema.runMessages).values({
      id: randomUUID(),
      runId,
      nodeAttemptId,
      sequence: 0,
      role: "user",
      content: `Implement the widget.\n\n${SECRET}`,
      promptDispatchKey: `dispatch:${nodeAttemptId}:0`,
    });

    const wire = wireOf(await readActivity(projectId, runId));

    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("Implement the widget");
  }, 60_000);

  it("CT-TRC-11: still serves a scratch run's own operator message", async () => {
    const { projectId, runId } = await seedRun("scratch");

    await testDatabase.db.insert(schema.runMessages).values({
      id: randomUUID(),
      runId,
      // A scratch dialog is a single-session run: no node attempt, and the
      // transcript writer leaves the dispatch key NULL.
      nodeAttemptId: null,
      sequence: 0,
      role: "user",
      content: "please rename the widget",
      promptDispatchKey: null,
    });

    const response = await readActivity(projectId, runId);

    expect(wireOf(response)).toContain("please rename the widget");
  }, 60_000);
});
