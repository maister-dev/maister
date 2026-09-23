import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { Pool } from "pg";

import { loadFixtures } from "./_seed/fixtures";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";

// Seeded in the shape the P0-5 writer produces: agent-kind draft children with
// production artifact ids/defs, the round debate on the PARENT run, and a HITL
// schema with stable slots, classifications and an escalation reason.
const ids = {
  task: randomUUID(),
  run: randomUUID(),
  partialChild: randomUUID(),
  unavailableChild: randomUUID(),
  completeChild: randomUUID(),
  attempt: randomUUID(),
  request: randomUUID(),
};
const draftArtifactId = (childRunId: string, participantId: string) =>
  `run:${childRunId}:consensus-draft:${ids.attempt}:${participantId}:r1`;
const partialArtifact = draftArtifactId(ids.partialChild, "planner-a");
const completeArtifact = draftArtifactId(ids.completeChild, "planner-c");
const debateArtifact = `run:${ids.attempt}:consensus-round-debate:1`;
const fullDraft = `${"draft body ".repeat(6_000)}\nCONSENSUS-E2E-LAST-LINE`;
const marker =
  "\n[consensus text truncated: dropped 40960 UTF-8 bytes; cap 32000 bytes]";
const pool = new Pool({ connectionString: resolvePostgresDbUrl() });

function payloadPath(runId: string, artifactId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/payload`;
}

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
    for (const [childId, participantId, status] of [
      [ids.partialChild, "planner-a", "Failed"],
      [ids.unavailableChild, "planner-b", "Failed"],
      [ids.completeChild, "planner-c", "Done"],
    ] as const) {
      await pool.query(
        `INSERT INTO runs (id, run_kind, agent_id, trigger_source, trigger_payload, agent_workspace,
           task_id, project_id, flow_id, parent_run_id, root_run_id, status, current_step_id,
           flow_version, flow_revision, launch_mode, delegation_snapshot, workspace_mode,
           started_at, ended_at)
         VALUES ($1, 'agent', NULL, 'flow', $2, 'repo_read', $3, $4, NULL, $5, $5, $6,
           'consensus-draft', 'agent', 'manual', 'manual', $7, 'own', now(), now())`,
        [
          childId,
          JSON.stringify({
            kind: "consensus_draft",
            nodeAttemptId: ids.attempt,
            participantId,
            participantKind: "runner",
            round: 1,
            workspaceMode: "repo_read",
          }),
          ids.task,
          projectId,
          ids.run,
          status,
          JSON.stringify({
            kind: "runner",
            runnerId: "claude",
            participantId,
            nodeId: "review",
            nodeAttemptId: ids.attempt,
            round: 1,
            workspaceMode: "repo_read",
          }),
        ],
      );
    }
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at)
       VALUES ($1, $2, 'review', 'consensus', 1, 'NeedsInput', now())`,
      [ids.attempt, ids.run],
    );
    await pool.query(
      `INSERT INTO artifact_instances
         (id, run_id, node_id, artifact_def_id, kind, producer, locator, visibility)
       VALUES ($1, $2, 'consensus-draft', 'default:consensus-draft', 'human_note', 'runner', $3, 'internal'),
              ($4, $5, 'consensus-draft', 'default:consensus-draft', 'human_note', 'runner', $6, 'internal')`,
      [
        partialArtifact,
        ids.partialChild,
        JSON.stringify({
          kind: "inline",
          text: fullDraft,
          partial: true,
          stopReason: "end_turn",
          reason: "output_cap_exceeded",
        }),
        completeArtifact,
        ids.completeChild,
        JSON.stringify({ kind: "inline", text: "Complete plan body" }),
      ],
    );
    await pool.query(
      `INSERT INTO artifact_instances
         (id, run_id, node_attempt_id, node_id, attempt, artifact_def_id, kind, producer, locator, visibility)
       VALUES ($1, $2, $3, 'review', 1, 'consensus-round-debate', 'human_note', 'runner', $4, 'internal')`,
      [
        debateArtifact,
        ids.run,
        ids.attempt,
        JSON.stringify({ kind: "inline", text: '{"round":1,"verdicts":[]}' }),
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
          nodeAttemptId: ids.attempt,
          round: 1,
          maxRounds: 2,
          allowedDecisions: [
            "pick-draft-1",
            "pick-draft-2",
            "pick-draft-3",
            "provide-resolution",
            "re-run-round",
            "abort",
          ],
          escalationReason: "technical_only",
          drafts: [
            {
              decision: "pick-draft-1",
              slot: 1,
              classification: "partial",
              stopReason: "end_turn",
              reason: "output_cap_exceeded",
              excerpt: `Partial proposal${marker}`,
              excerptBounds: {
                bytes: 72_960,
                retainedBytes: 32_000,
                droppedBytes: 40_960,
                cap: 32_000,
              },
              artifactRef: partialArtifact,
              artifactRunId: ids.partialChild,
            },
            {
              decision: "pick-draft-2",
              slot: 2,
              classification: "unavailable",
            },
            {
              decision: "pick-draft-3",
              slot: 3,
              classification: "complete",
              excerpt: "Complete plan body",
              artifactRef: completeArtifact,
              artifactRunId: ids.completeChild,
            },
          ],
          disagreements: [],
          technicalFailures: [
            {
              verifierId: "reviewer-b",
              targetParticipantId: "planner-c",
              parseStatus: "invalid_json",
              errorCode: "invalid_json",
              targetSlot: 3,
            },
          ],
          debateLog: {
            excerpt: '{"round":1,"verdicts":[]}',
            artifactRef: debateArtifact,
            artifactRunId: ids.run,
          },
        }),
      ],
    );
  });

  test.afterAll(async () => {
    await pool.query("DELETE FROM runs WHERE parent_run_id = $1", [ids.run]);
    await pool.query("DELETE FROM runs WHERE id = $1", [ids.run]);
    await pool.query("DELETE FROM tasks WHERE id = $1", [ids.task]);
    await pool.end();
  });

  test("English inbox renders slots, causes, technical failures and downloads", async ({
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
    await expect(card.getByTestId("consensus-escalation")).toContainText(
      "Verifiers could not judge the drafts",
    );
    await expect(card).toContainText("Partial · output size limit reached");
    await expect(card).toContainText("Excerpt — 40 KB omitted");
    await expect(card).not.toContainText("[consensus text truncated");
    await expect(card.getByTestId("consensus-pick-draft-2")).toBeDisabled();
    await expect(card.getByTestId("consensus-unavailable-draft-2")).toHaveText(
      "Unavailable",
    );
    await expect(card.getByTestId("consensus-pick-draft-3")).toBeEnabled();
    await expect(card).toContainText("Verifier reviewer-b · Draft 3");
    await expect(card).toContainText("returned malformed JSON");
    await expect(card).not.toContainText("No material disagreements");
    await expect(
      card.getByRole("link", { name: "Download full draft 1" }),
    ).toHaveAttribute("href", payloadPath(ids.partialChild, partialArtifact));
    await expect(
      card.getByRole("link", { name: "Download full debate" }),
    ).toHaveAttribute("href", payloadPath(ids.run, debateArtifact));

    const draft = await page.request.get(
      payloadPath(ids.partialChild, partialArtifact),
    );

    expect(draft.ok()).toBe(true);
    expect(await draft.text()).toContain("CONSENSUS-E2E-LAST-LINE");
    const debate = await page.request.get(payloadPath(ids.run, debateArtifact));

    expect(debate.ok()).toBe(true);
    const wrongRun = await page.request.get(
      payloadPath(ids.run, partialArtifact),
    );

    expect(wrongRun.status()).toBe(404);
  });

  test("Russian inbox labels the same evidence", async ({ context, page }) => {
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
    await expect(card).toContainText(
      "Неполный · достигнут лимит объёма вывода",
    );
    await expect(card.getByTestId("consensus-unavailable-draft-2")).toHaveText(
      "Недоступен",
    );
    await expect(card.getByTestId("consensus-pick-draft-2")).toBeDisabled();
    await expect(card).toContainText("Проверяющий reviewer-b · черновик 3");
    await expect(card).toContainText("Технические ошибки проверки");
    await expect(
      card.getByRole("link", { name: "Скачать полный черновик 1" }),
    ).toBeVisible();
    await expect(
      card.getByRole("link", { name: "Скачать полный журнал обсуждения" }),
    ).toBeVisible();
  });
});
