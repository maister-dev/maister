import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  e2eClaudeRunnerSnapshot,
  seedDefaultRunSession,
  withE2EDb,
} from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

// ADR-149 T4.3 — the Evaluation Lab controlled-launch surface in a real browser,
// replacing the retired experiment-comparison spec. The heavy execution/judge
// machinery is integration-proven (studies/participants/verdicts + launch-batch
// suites); this walks the operator journey those tests cannot: create Study →
// observe a run → inline controlled batch (2 variants × 1 replicate) → per-item
// batch status → the start-evaluation launcher → a human verdict.
//
// The controlled-launch UI ships NO test ids — selectors are role/label/text,
// matched to messages.evaluationsLab / evaluationsControlled (EN).
//
// Infra (shared-infra trap): ports 3100/7788 + the maister_e2e DB are shared
// across ALL worktrees — kill stale listeners before a run and baseline-prove a
// red run before blaming this branch.

type CreatedTaskResponse = { taskId: string };
type CreatedStudyResponse = { study: { id: string } };
type BatchCreateResponse = {
  batchId: string;
  deduped: boolean;
  itemCount: number;
};
type BatchViewResponse = {
  id: string;
  status: string;
  items: Array<{ id: string; status: string; recipeId: string }>;
};

// The controlled-launch batch drive is fire-and-forget: the create route returns
// 201 before the async drive runs, so a per-item status may still be queued when
// this spec reads it. Assert the status is one of the FSM's values, not a fixed
// terminal one.
const KNOWN_ITEM_STATUS = new Set([
  "queued",
  "launching",
  "launched",
  "failed",
  "skipped",
]);

// A schema-valid inline controlled recipe (the launch-batches route strict-parses
// each `definition`). The flow ref + contract digests are opaque non-empty
// strings — nothing dereferences them at batch-create time, and the launch seam
// drives off the Study's task, not this ref.
function inlineRecipe(
  flowRefId: string,
  taskId: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    flow: {
      flowRefId,
      flowRevisionId: `${flowRefId}-rev`,
      inputContractDigest: "d-in",
      artifactContractDigest: "d-art",
    },
    inputs: { taskSnapshotRef: taskId, formValues: {} },
    executionPolicy: { preset: "supervised" },
  };
}

test("evaluation lab: study, observed participant, controlled batch, start affordance, verdict", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixtures = loadFixtures();
  const fx = fixtures.byKey.board;
  const suffix = randomUUID().slice(0, 8);

  // A task on the board flow so the Study has a launchable Flow context.
  const taskRes = await page.request.post(
    `/api/projects/${fx.projectSlug}/tasks`,
    {
      data: {
        title: `Eval lab task ${suffix}`,
        prompt: "Compare two runs through an evaluation study.",
        flowId: fx.flowId,
      },
    },
  );

  expect(taskRes.status()).toBe(201);
  const { taskId } = (await taskRes.json()) as CreatedTaskResponse;

  const runA = randomUUID();
  const runB = randomUUID();

  // A minimal ENABLED evaluation profile (platform-scoped) so the Start
  // Evaluation launcher enables + populates. The method/panel/install rows exist
  // only to satisfy the profile's NOT NULL FKs — listEnabledProfiles reads
  // id/name/enabled only. A live Start click is out of scope here (it needs a
  // health-ready method + a valid panel policy, beyond FK seeding); the enabled
  // launcher affordance is asserted instead.
  const pkgInstallId = `eval-pkg-${suffix}`;
  const methodRevId = randomUUID();
  const panelId = randomUUID();
  const profileId = randomUUID();
  const profileName = `E2E profile ${suffix}`;

  await withE2EDb(async (pool) => {
    // Two Review flow runs to observe (the runs' execution is not this spec's
    // subject — mirrors the retired experiment-comparison seed).
    await pool.query(
      `INSERT INTO runs
         (id, run_kind, task_id, project_id, flow_id, status, current_step_id,
          flow_version, flow_revision, created_by_user_id, started_at, ended_at)
       VALUES
         ($1, 'flow', $3, $4, $5, 'Review', 'review', 'v1.0.0', 'e2e', $6,
          now() - interval '6 minutes', now() - interval '2 minutes'),
         ($2, 'flow', $3, $4, $5, 'Review', 'review', 'v1.0.0', 'e2e', $6,
          now() - interval '5 minutes', now() - interval '1 minute')`,
      [runA, runB, taskId, fx.projectId, fx.flowId, fixtures.users.admin.id],
    );
    await seedDefaultRunSession(pool, {
      capabilityAgent: "claude",
      runId: runA,
      runnerId: fx.runnerId,
      runnerSnapshot: e2eClaudeRunnerSnapshot(fx.runnerId),
    });
    await seedDefaultRunSession(pool, {
      capabilityAgent: "claude",
      runId: runB,
      runnerId: fx.runnerId,
      runnerSnapshot: e2eClaudeRunnerSnapshot(fx.runnerId),
    });

    await pool.query(
      `INSERT INTO package_installs
         (id, source_url, name, version_label, resolved_revision, manifest,
          manifest_digest, installed_path, package_status, trust_status)
       VALUES ($1, 'e2e://eval', $2, 'v1.0.0', $3, '{}'::jsonb, 'd',
               '/tmp/e2e-eval', 'Installed', 'trusted')`,
      [pkgInstallId, `eval-pkg-${suffix}`, `rev-${suffix}`],
    );
    await pool.query(
      `INSERT INTO evaluation_method_revisions
         (id, package_install_id, method_id, qualified_id, package_name,
          version_label, schema_version, normalized_definition, definition_digest,
          prompt_digest, schema_digest, compat, activation)
       VALUES ($1, $2, 'quality', $3, $4, 'v1.0.0', 1, '{}'::jsonb, 'dd', 'dp',
               'ds', '{}'::jsonb, 'enabled')`,
      [
        methodRevId,
        pkgInstallId,
        `eval-pkg-${suffix}:quality`,
        `eval-pkg-${suffix}`,
      ],
    );
    await pool.query(
      `INSERT INTO evaluation_judge_panels (id, name, role_bindings, policy, enabled)
       VALUES ($1, $2, '[]'::jsonb, '{}'::jsonb, true)`,
      [panelId, `E2E panel ${suffix}`],
    );
    await pool.query(
      `INSERT INTO evaluation_profiles
         (id, name, method_revision_id, panel_id, enabled)
       VALUES ($1, $2, $3, $4, true)`,
      [profileId, profileName, methodRevId, panelId],
    );
  });

  // ── Create the Study ──────────────────────────────────────────────────────
  const studyRes = await page.request.post(
    `/api/projects/${fx.projectSlug}/evaluations/studies`,
    {
      data: { taskId, title: `Eval study ${suffix}`, purpose: "compare runs" },
    },
  );

  expect(studyRes.status()).toBe(201);
  const { study } = (await studyRes.json()) as CreatedStudyResponse;

  // ── Add observed participants (two → satisfies the ≥2 launch gate) ─────────
  for (const [runId, label] of [
    [runA, `Observed A ${suffix}`],
    [runB, `Observed B ${suffix}`],
  ] as const) {
    const addRes = await page.request.post(
      `/api/projects/${fx.projectSlug}/evaluations/studies/${study.id}/participants`,
      { data: { runIds: [runId], labels: { [runId]: label } } },
    );

    expect(addRes.status()).toBe(201);
  }

  // ── Inline controlled batch: 2 variants × 1 replicate ─────────────────────
  const batchRes = await page.request.post(
    `/api/projects/${fx.projectSlug}/evaluations/studies/${study.id}/launch-batches`,
    {
      data: {
        idempotencyKey: `eval-batch-${suffix}`,
        items: [
          { definition: inlineRecipe(fx.flowId, taskId), replicateCount: 1 },
          { definition: inlineRecipe(fx.flowId, taskId), replicateCount: 1 },
        ],
      },
    },
  );

  expect(batchRes.status()).toBe(201);
  const batchCreated = (await batchRes.json()) as BatchCreateResponse;

  expect(batchCreated.deduped).toBe(false);
  expect(batchCreated.itemCount).toBe(2);

  // Per-item batch status is visible (the batch-strip's data source): 2 items,
  // each in a known FSM state.
  const batchView = await page.request.get(
    `/api/projects/${fx.projectSlug}/evaluations/studies/${study.id}/launch-batches/${batchCreated.batchId}`,
  );

  expect(batchView.ok()).toBeTruthy();
  const batch = (await batchView.json()) as BatchViewResponse;

  expect(batch.items).toHaveLength(2);
  for (const item of batch.items) {
    expect(KNOWN_ITEM_STATUS.has(item.status)).toBeTruthy();
  }

  // ── Study Lab UI ──────────────────────────────────────────────────────────
  await page.goto(`/projects/${fx.projectSlug}/evaluations/${study.id}`);

  await expect(
    page.getByRole("heading", { name: `Eval study ${suffix}` }),
  ).toBeVisible();

  // Participants table: the two observed runs, both source "Observed".
  await expect(
    page.getByRole("heading", { name: "Participants", exact: false }),
  ).toBeVisible();
  await expect(page.getByText(`Observed A ${suffix}`)).toBeVisible();
  await expect(page.getByText(`Observed B ${suffix}`)).toBeVisible();
  await expect(
    page.getByText("Observed", { exact: true }).first(),
  ).toBeVisible();

  // The controlled-launch surface renders (canManage admin).
  await expect(
    page.getByRole("button", { name: "Launch variants" }),
  ).toBeVisible();

  // Start-evaluation affordance: enabled (≥2 participants + one enabled profile),
  // and the seeded profile is offered (native <option> → assert attached).
  await expect(
    page.getByRole("button", { name: "Start evaluation" }),
  ).toBeEnabled();
  await expect(page.locator("option", { hasText: profileName })).toBeAttached();

  // ── Record a human verdict (zero-citation inconclusive, acknowledged) ──────
  await page.getByLabel("Outcome").selectOption("inconclusive");
  await page
    .getByRole("checkbox", {
      name: "I acknowledge this verdict cites no evaluation evidence.",
    })
    .check();
  await page
    .getByPlaceholder("Rationale (optional)")
    .fill(`No evaluations run ${suffix}`);

  const recordResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/evaluations/studies/${study.id}/verdicts`) &&
      r.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Record verdict" }).click();
  expect((await recordResponse).status()).toBe(201);

  // The append-only verdict history shows the recorded outcome.
  await expect(
    page.getByRole("listitem").filter({ hasText: "Inconclusive" }).first(),
  ).toBeVisible();
});
