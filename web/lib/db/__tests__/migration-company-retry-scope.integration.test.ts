import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { parseAgentRetryRecipe } from "@/lib/agents/retry-snapshot";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let projectId: string;
let before: Readonly<Record<string, unknown>>[];
const agentId = "migration:retry-observer";

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "company_retry_scope_upgrade" },
    "0238_company_trigger_scope",
  );
  projectId = (await seedProjectRow(database.db)).id;
  const definition = {
    parsed: parseAgentDefinition(
      agentId,
      "---\nname: Observer\ndescription: Inspect only\nmode: session\nworkspace: none\ntriggers: [manual]\nrisk_tier: read_only\n---\nInspect without mutation.",
    ),
    sourcePath: "/retained/observer.md",
    packageName: "migration",
    packageInstallId: randomUUID(),
    installedPath: "/retained",
    manifest: {},
    versionLabel: "legacy",
    resolvedRevision: "retained-version",
    execTrust: "trusted",
  };

  for (const version of [1, 2]) {
    const recipe = {
      version,
      ...(version === 2
        ? { strategy: "pre_work_retry", qualificationSha: null }
        : {}),
      agentId,
      projectId,
      taskId: null,
      taskRevision: null,
      definition,
      configuration: {},
      trigger: { source: "manual", eventId: null, payload: null },
      runner: testRunnerSnapshot("retained-runner"),
      policy: { preset: "supervised" },
      contextDigest: "a".repeat(64),
      project: { mainBranch: "main", branchPrefix: null, branchBase: null },
      ...(version === 2
        ? {
            scheduledRequestSnapshot: {
              version: 1,
              scheduleId: randomUUID(),
              triggerAttemptId: randomUUID(),
              requestAtLaunch: "Original request\nИсходный запрос",
            },
          }
        : {}),
    };

    await database.pool.query(
      "INSERT INTO agent_retry_intents(project_id,source_agent_id,source_run_id,actor_identity,request_key,request_digest,selected_runner_id,recipe,preview_fingerprint,successor_run_id,state,refusal_reason) VALUES($1,$2,$3,'retained-actor',$4,$5,'retained-runner',$6::jsonb,$5,$7,'refused','retained_refusal')",
      [
        projectId,
        agentId,
        randomUUID(),
        randomUUID(),
        "b".repeat(64),
        JSON.stringify(recipe),
        randomUUID(),
      ],
    );
  }
  before = (
    await database.pool.query(
      "SELECT to_jsonb(i) AS value FROM agent_retry_intents i ORDER BY id",
    )
  ).rows.map((row: { value: Record<string, unknown> }) => row.value);
  await applyMainMigration(database.db, "0239_company_retry_scope");
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("preserves populated v1/v2 retry receipts, absent fields, manifests and request bytes while adding only an unknown company owner", async () => {
  const after = (
    await database.pool.query(
      "SELECT to_jsonb(i) AS value FROM agent_retry_intents i ORDER BY id",
    )
  ).rows.map((row: { value: Record<string, unknown> }) => row.value);

  expect(after).toEqual(before.map((row) => ({ ...row, company_id: null })));
  for (const row of after) {
    const recipe = parseAgentRetryRecipe(row.recipe);

    expect(recipe.projectId).toBe(projectId);
    expect(recipe).not.toHaveProperty("owner");
    expect(recipe).not.toHaveProperty("assignment");
    if (recipe.version === 1)
      expect(recipe).not.toHaveProperty("scheduledRequestSnapshot");
    expect(recipe.definition.parsed.prompt).toBe("Inspect without mutation.");
  }
  const constraints = (
    await database.pool.query(
      "SELECT conname FROM pg_constraint WHERE conrelid='agent_retry_intents'::regclass",
    )
  ).rows.map((row: { conname: string }) => row.conname);

  expect(constraints).toEqual(
    expect.arrayContaining([
      "agent_retry_owner_check",
      "agent_retry_actor_request_uq",
      "agent_retry_successor_uq",
      "agent_retry_recipe_check",
    ]),
  );
});

it("keeps immutable project receipts and their existing project cleanup semantics without requiring a Brain store", async () => {
  await expect(
    database.pool.query(
      "UPDATE agent_retry_intents SET project_id=NULL WHERE project_id=$1",
      [projectId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await database.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM agent_retry_intents WHERE project_id=$1",
        [projectId],
      )
    ).rows,
  ).toEqual([]);
});
