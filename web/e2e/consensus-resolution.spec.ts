import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { loadFixtures } from "./_seed/fixtures";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";

const ids = {
  task: randomUUID(),
  run: randomUUID(),
  child: randomUUID(),
  attempt: randomUUID(),
  request: randomUUID(),
  artifact: `consensus-e2e-draft-${randomUUID()}`,
};
const fullDraft = `${"draft body ".repeat(6_000)}\nCONSENSUS-E2E-LAST-LINE`;
const pool = new Pool({ connectionString: resolvePostgresDbUrl() });

test.describe("P0-5 consensus inbox evidence", () => {
  test.beforeAll(async () => {
    const projectId = loadFixtures().byKey.m17.project2Id;
    const { rows } = await pool.query<{ flow_id: string }>(
      "SELECT flow_id FROM runs WHERE id = $1",
      [loadFixtures().byKey.m17.project2RunId],
    );
    const flowId = rows[0]?.flow_id;

    if (!flowId) throw new Error("M17 Flow fixture is missing");
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
       VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE project_id = $2),
         'P0-5 consensus evidence', 'Review the partial draft', $3, 'InFlight', 'Backlog')`,
      [ids.task, projectId, flowId],
    );
    await pool.query(
      `INSERT INTO runs (id, task_id, project_id, flow_id, status, current_step_id, flow_version, started_at)
       VALUES ($1, $2, $3, $4, 'NeedsInput', 'review', 'v0.0.1', now())`,
      [ids.run, ids.task, projectId, flowId],
    );
    await pool.query(
      `INSERT INTO runs (id, task_id, project_id, flow_id, parent_run_id, status, current_step_id, flow_version, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, 'Failed', 'consensus-draft', 'v0.0.1', now(), now())`,
      [ids.child, ids.task, projectId, flowId, ids.run],
    );
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
       VALUES ($1, $2, 'review', 'consensus', 1, 'NeedsInput', now())`,
      [ids.attempt, ids.run],
    );
    await pool.query(
      `INSERT INTO artifact_instances
         (id, run_id, node_id, artifact_def_id, kind, producer, locator, visibility)
       VALUES ($1, $2, 'consensus-draft', 'consensus-draft', 'human_note', 'runner', $3, 'shared')`,
      [
        ids.artifact,
        ids.child,
        JSON.stringify({
          kind: "inline",
          text: fullDraft,
          partial: true,
          stopReason: "max_tokens",
        }),
      ],
    );
    await pool.query(
      `INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt, criticality)
       VALUES ($1, $2, 'review', 'human', $3, 'Choose a consensus draft', 'medium')`,
      [
        ids.request,
        ids.run,
        JSON.stringify({
          kind: "consensus_resolution",
          round: 1,
          allowedDecisions: [
            "pick-draft-1",
            "provide-resolution",
            "re-run-round",
            "abort",
          ],
          drafts: [
            {
              participantLabel: "Planner A",
              excerpt: "Partial proposal",
              classification: "partial",
              stopReason: "max_tokens",
              artifactRef: ids.artifact,
              artifactRunId: ids.child,
            },
          ],
          disagreements: [],
          technicalFailures: [
            {
              verifierId: "reviewer-b",
              targetParticipantId: "planner-a",
              parseStatus: "invalid_json",
              errorCode: "invalid_json",
            },
          ],
          debateLog: { excerpt: "Verifier output was invalid JSON." },
        }),
      ],
    );
  });

  test.afterAll(async () => {
    await pool.query("DELETE FROM runs WHERE id = $1", [ids.child]);
    await pool.query("DELETE FROM runs WHERE id = $1", [ids.run]);
    await pool.query("DELETE FROM tasks WHERE id = $1", [ids.task]);
    await pool.end();
  });

  test("English inbox renders partial and technical evidence with the full child artifact", async ({
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "en",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      },
    ]);
    await page.goto("/inbox");
    const card = page.getByTestId("hitl-card").filter({
      hasText: "P0-5 consensus evidence",
    });

    await card.getByRole("button", { name: /P0-5 consensus evidence/ }).click();
    await expect(card.getByTestId("consensus-hitl-card")).toBeVisible();
    await expect(card).toContainText("Partial · max_tokens");
    await expect(card).toContainText("Technical verification failures");
    await expect(card.getByTestId("consensus-pick-draft-1")).toBeVisible();
    await expect(
      card.getByRole("link", { name: "View full draft" }),
    ).toHaveAttribute(
      "href",
      `/api/runs/${ids.child}/artifacts/${ids.artifact}/payload`,
    );
    const payload = await page.request.get(
      `/api/runs/${ids.child}/artifacts/${ids.artifact}/payload`,
    );

    expect(payload.ok()).toBe(true);
    expect(await payload.text()).toContain("CONSENSUS-E2E-LAST-LINE");
    const wrongRun = await page.request.get(
      `/api/runs/${ids.run}/artifacts/${ids.artifact}/payload`,
    );

    expect(wrongRun.status()).toBe(404);
  });

  test("Russian inbox labels the same partial and technical evidence", async ({
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ru",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      },
    ]);
    await page.goto("/inbox");
    const card = page.getByTestId("hitl-card").filter({
      hasText: "P0-5 consensus evidence",
    });

    await card.getByRole("button", { name: /P0-5 consensus evidence/ }).click();
    await expect(card.getByTestId("consensus-hitl-card")).toBeVisible();
    await expect(card).toContainText("Неполный · max_tokens");
    await expect(card).toContainText("Технические ошибки проверки");
    await expect(
      card.getByRole("link", { name: "Открыть полный черновик" }),
    ).toBeVisible();
  });
});
