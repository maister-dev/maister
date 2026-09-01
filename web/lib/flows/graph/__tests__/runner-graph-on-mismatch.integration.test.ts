import type { NodeAttempt, Run } from "@/lib/db/schema";

import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// M38 (ADR-103) on_mismatch — engine-initiated rework on a structured-output
// validation failure. Reuses the M26 fixture schema
// (_fixtures/m26-output-flow/schemas/result.json: { verdict: string (required), score? }):
// emitting JSON without `verdict` fails validation.

const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");
const SCHEMA = "./schemas/result.json";
// ADR-162 fixture: { verdict: string (required), tags?: array<string>, payload?: json }
const OPEN_SCHEMA = "./schemas/open.json";

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  container = testDatabase.container;

  db = testDatabase.db;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await testDatabase?.stop();
});

function seedGraphRun(manifest: unknown): Promise<SeededGraphRun> {
  return seedGraphRunShared(db, manifest, {
    flowRefId: "m38",
    installedPath: FIXTURE_PATH,
    flowRevision: true,
  });
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

describe("runGraph — M38 on_mismatch rework", () => {
  it("on_mismatch: retry re-runs the same node with the validation error in commentsVar", async () => {
    // Attempt 1 emits invalid output (no `verdict`); attempt 2 (marker present)
    // emits valid output. The command echoes the injected commentsVar so we can
    // confirm the validation error reached the retried attempt's prompt.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command:
              `echo "notes:{{ fix_notes }}"; ` +
              `if [ -f once.marker ]; then echo '{"verdict":"ok","score":1}' > "$MAISTER_OUTPUT_FILE"; ` +
              `else echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"; touch once.marker; fi`,
          },
          output: { result: { schema: SCHEMA, on_mismatch: "retry" } },
          rework: {
            allowedTargets: ["extract"],
            workspacePolicies: ["keep"],
            maxLoops: 3,
            commentsVar: "fix_notes",
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = (await getAttempts(seeded.runId))
      .filter((a) => a.nodeId === "extract")
      .sort((a, b) => a.attempt - b.attempt);

    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("Reworked");
    expect(attempts[0].decision).toBe("retry");
    expect(attempts[1].status).toBe("Succeeded");
    // The retried attempt rendered the injected validation error.
    expect(attempts[1].stdout ?? "").toContain("notes:");
    expect(attempts[1].stdout ?? "").toMatch(/required|schema|absent/i);
  }, 60_000);

  it("on_mismatch: <outcome> redirects to a rework target with the error injected", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`, // always missing verdict
          },
          output: { result: { schema: SCHEMA, on_mismatch: "repair" } },
          rework: {
            allowedTargets: ["fixer"],
            workspacePolicies: ["keep"],
            maxLoops: 1,
            commentsVar: "notes",
          },
          transitions: { repair: "fixer" },
        },
        {
          id: "fixer",
          type: "cli",
          action: { command: `echo "fixing:{{ notes }}"` },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "extract")?.status).toBe(
      "Reworked",
    );
    const fixer = attempts.find((a) => a.nodeId === "fixer");

    expect(fixer?.status).toBe("Succeeded");
    expect(fixer?.stdout ?? "").toMatch(/fixing:.*(required|schema|absent)/i);
  }, 60_000);

  it("a node WITHOUT on_mismatch still CONFIG-fails on malformed output (M26 regression)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`,
          },
          output: { result: { schema: SCHEMA } }, // no on_mismatch
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
    expect(
      (await getAttempts(seeded.runId)).find((a) => a.nodeId === "extract")
        ?.status,
    ).toBe("Failed");
  }, 60_000);

  it("an always-malformed on_mismatch: retry node halts at maxLoops + 1 attempts (Failed)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"`, // never valid
          },
          output: { result: { schema: SCHEMA, on_mismatch: "retry" } },
          rework: {
            allowedTargets: ["extract"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "fix_notes",
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    // initial visit + maxLoops(2) reworks = 3 attempts, then the loop-top
    // backstop refuses the 4th entry with CONFIG.
    const attempts = (await getAttempts(seeded.runId)).filter(
      (a) => a.nodeId === "extract",
    );

    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.status === "Reworked")).toBe(true);
  }, 60_000);

  it("records the manifest workspacePolicy (non-keep) on the reworked attempt, not a hardcoded keep", async () => {
    // The flow allows ONLY rewind-to-node-checkpoint (no "keep"). The engine must
    // derive the rework policy from rework.workspacePolicies[0] and record
    // "rewind-to-node-checkpoint" on the reworked attempt — never a silent "keep".
    // The non-git fixture worktree captures no checkpoint, so the apply degrades
    // to keep with a WARN (which is why the marker survives and attempt 2
    // succeeds); the LEDGER still reflects the author's chosen policy, exactly as
    // the human-rework path records its chosen policy on degrade.
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command:
              `if [ -f once.marker ]; then echo '{"verdict":"ok","score":1}' > "$MAISTER_OUTPUT_FILE"; ` +
              `else echo '{"score":1}' > "$MAISTER_OUTPUT_FILE"; touch once.marker; fi`,
          },
          output: { result: { schema: SCHEMA, on_mismatch: "retry" } },
          rework: {
            allowedTargets: ["extract"],
            workspacePolicies: ["rewind-to-node-checkpoint"],
            maxLoops: 3,
            commentsVar: "fix_notes",
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = (await getAttempts(seeded.runId))
      .filter((a) => a.nodeId === "extract")
      .sort((a, b) => a.attempt - b.attempt);

    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("Reworked");
    // The fix: the engine records the author's declared policy, NOT "keep".
    expect(attempts[0].workspacePolicy).toBe("rewind-to-node-checkpoint");
    expect(attempts[1].status).toBe("Succeeded");
  }, 60_000);
});

// --- ADR-162 (AC-17): the new failure classes route through the SAME rework ---
// One case per class. The bad-then-good marker pattern mirrors the M38 retry
// test above; each asserts the class-specific reason reached `commentsVar`.

describe("runGraph — ADR-162 on_mismatch over the new failure classes", () => {
  function retryFlow(badPayloadCommand: string): unknown {
    return {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "3.6.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command:
              `echo "notes:{{ fix_notes }}"; ` +
              `if [ -f once.marker ]; then echo '{"verdict":"ok"}' > "$MAISTER_OUTPUT_FILE"; ` +
              `else ${badPayloadCommand}; touch once.marker; fi`,
          },
          output: { result: { schema: OPEN_SCHEMA, on_mismatch: "retry" } },
          rework: {
            allowedTargets: ["extract"],
            workspacePolicies: ["keep"],
            maxLoops: 3,
            commentsVar: "fix_notes",
          },
          transitions: { success: "done" },
        },
      ],
    };
  }

  async function expectRetriedWithReason(
    badPayloadCommand: string,
    reason: RegExp,
  ): Promise<void> {
    const seeded = await seedGraphRun(retryFlow(badPayloadCommand));

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = (await getAttempts(seeded.runId))
      .filter((a) => a.nodeId === "extract")
      .sort((a, b) => a.attempt - b.attempt);

    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("Reworked");
    expect(attempts[0].decision).toBe("retry");
    expect(attempts[1].status).toBe("Succeeded");
    expect(attempts[1].stdout ?? "").toMatch(reason);
  }

  it("an unsafe own key reworks with the JSON path in commentsVar", async () => {
    await expectRetriedWithReason(
      `printf '{"verdict":"ok","__proto__":{"x":1}}' > "$MAISTER_OUTPUT_FILE"`,
      /notes:.*__proto__/,
    );
  }, 60_000);

  it("a payload past the nesting-depth limit reworks with the limit in commentsVar", async () => {
    // 64 nested objects under `deep` sit at depths 2..65 — one past the cap.
    const deep =
      `open=""; close=""; i=0; ` +
      `while [ $i -lt 64 ]; do open="\${open}{\\"n\\":"; close="\${close}}"; i=$((i+1)); done; ` +
      `printf '{"verdict":"ok","payload":%s1%s}' "$open" "$close" > "$MAISTER_OUTPUT_FILE"`;

    await expectRetriedWithReason(deep, /notes:.*nesting depth \(64\)/);
  }, 60_000);

  it("an items element mismatch reworks with field[i] in commentsVar", async () => {
    await expectRetriedWithReason(
      `printf '{"verdict":"ok","tags":["a",2]}' > "$MAISTER_OUTPUT_FILE"`,
      /notes:.*tags\[1\]/,
    );
  }, 60_000);

  it("without on_mismatch a new-class failure is still a hard CONFIG", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "3.6.0" },
      nodes: [
        {
          id: "extract",
          type: "cli",
          action: {
            command: `printf '{"verdict":"ok","__proto__":{"x":1}}' > "$MAISTER_OUTPUT_FILE"`,
          },
          output: { result: { schema: OPEN_SCHEMA } },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const extract = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "extract",
    );

    expect(extract?.status).toBe("Failed");
    expect(extract?.errorCode).toBe("CONFIG");
    expect(extract?.stdout ?? "").toContain("__proto__");
  }, 60_000);
});
