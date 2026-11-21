import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withE2EDb } from "./_seed/db";

test.describe.configure({ timeout: 120_000 });

test("W09/W10 exposes the server's wait controls in a localized run detail", async ({
  page,
  context,
  baseURL,
}) => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const attemptId = randomUUID();
  const waitId = randomUUID().replaceAll("-", "").repeat(2);
  const condition = {
    schemaVersion: 1,
    kind: "signal",
    outcomes: ["success", "timeout", "cancelled"],
    parameters: { name: "build", timeoutSeconds: 3600 },
  };

  try {
    await withE2EDb(async (db) => {
      await db.query(
        `INSERT INTO projects (id,slug,name,repo_path,maister_yaml_path,task_key)
        VALUES ($1,$2,'Flow wait fixture',$3,$3,$4)`,
        [
          projectId,
          `wait-${projectId}`,
          `/tmp/wait-${projectId}`,
          `W${projectId.slice(0, 6).toUpperCase()}`,
        ],
      );
      await db.query(
        `INSERT INTO runs (id,project_id,run_kind,status,flow_version,flow_revision,current_step_id)
        VALUES ($1,$2,'flow','Waiting','1.0.0','fixture','verify')`,
        [runId, projectId],
      );
      await db.query(
        `INSERT INTO workspaces (id,run_id,project_id,branch,worktree_path,parent_repo_path)
        VALUES (gen_random_uuid()::text,$1,$2,'wait-browser',$3,$4)`,
        [runId, projectId, `/tmp/wait-${runId}`, `/tmp/wait-${projectId}`],
      );
      await db.query(
        `INSERT INTO node_attempts (id,run_id,node_id,node_type,status)
        VALUES ($1,$2,'verify','wait','Running')`,
        [attemptId, runId],
      );
      await db.query(
        `INSERT INTO run_waits (id,project_id,run_id,owner_kind,occurrence_key,node_attempt_id,flow_revision,condition_kind,
        condition,source_target_id,state,opened_at,next_due_at,deadline_at,absolute_cap_at)
        SELECT $1,$2,$3,'flow',$4,$4,'fixture','signal',$5,$3,'open',t,t+interval '1 hour',t+interval '1 hour',t+interval '2 hours'
        FROM (SELECT statement_timestamp() t) opened`,
        [waitId, projectId, runId, attemptId, condition],
      );
    });

    await page.goto(`/runs/${runId}`);
    await expect(
      page.getByRole("img", { name: "Waiting for build", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open inspector" }).click();
    let card = page.getByRole("region", { name: "Flow wait" });

    await expect(card.getByRole("heading")).toHaveText("Waiting for build");
    await expect(
      card.getByRole("combobox", { name: "Wait action" }),
    ).toBeVisible();

    await context.addCookies([
      { name: "NEXT_LOCALE", value: "ru", url: baseURL! },
    ]);
    await page.reload();
    await expect(
      page.getByRole("img", { name: "Ожидание: build", exact: true }),
    ).toBeVisible();
    const openInspector = page.getByRole("button", {
      name: "Открыть инспектор",
    });

    if (await openInspector.isVisible()) await openInspector.click();
    card = page.getByRole("region", { name: "Ожидание Flow" });
    await expect(card.getByRole("heading")).toHaveText("Ожидание: build");
    await card
      .getByRole("combobox", { name: "Действие с ожиданием" })
      .selectOption("deliver_signal");
    await expect(
      card.getByRole("combobox", { name: "Исход" }).getByRole("option"),
    ).toHaveText(["success"]);
    await card
      .getByRole("combobox", { name: "Действие с ожиданием" })
      .selectOption("resolve_now");
    await card.getByRole("combobox", { name: "Исход" }).selectOption("success");
    await card
      .getByRole("textbox", { name: "Причина" })
      .fill("Результат подтверждён оператором");
    const submitted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/waits/${waitId}/actions`) &&
        response.request().method() === "POST",
    );

    await card.getByRole("button", { name: "Применить действие" }).click();
    expect((await submitted).status()).toBe(200);
    await expect(card.getByText("Исход: success")).toBeVisible();
    await expect(
      card.getByRole("combobox", { name: "Действие с ожиданием" }),
    ).toHaveCount(0);
  } finally {
    await withE2EDb((db) =>
      db.query("DELETE FROM projects WHERE id=$1", [projectId]),
    );
  }
});

test("C05 shows the engine's refusal in Desk and the named run-detail region", async ({
  page,
}) => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const taskId = randomUUID();

  try {
    await withE2EDb(async (db) => {
      await db.query(
        `INSERT INTO projects (id,slug,name,repo_path,maister_yaml_path,task_key)
        VALUES ($1,$2,'Completion fixture',$3,$3,$4)`,
        [
          projectId,
          `completion-${projectId}`,
          `/tmp/completion-${projectId}`,
          `C${projectId.slice(0, 6).toUpperCase()}`,
        ],
      );
      await db.query(
        "INSERT INTO tasks (id,project_id,number,title,prompt) VALUES ($1,$2,1,'Completion requires review','fixture')",
        [taskId, projectId],
      );
      await db.query(
        "INSERT INTO runs (id,project_id,task_id,run_kind,status,flow_version,flow_revision,review_entered_at) VALUES ($1,$2,$3,'flow','Review','1.0.0','fixture',statement_timestamp())",
        [runId, projectId, taskId],
      );
      await db.query(
        `INSERT INTO workspaces (id,run_id,project_id,branch,worktree_path,parent_repo_path)
        VALUES (gen_random_uuid()::text,$1,$2,'completion-browser',$3,$4)`,
        [
          runId,
          projectId,
          `/tmp/completion-${runId}`,
          `/tmp/completion-${projectId}`,
        ],
      );
      await db.query(
        `INSERT INTO run_autonomous_decisions (id,run_id,project_id,action,phase,reason,project_revision,platform_revision,witness)
        VALUES ($1,$2,$3,'promote','refused','run_held',1,1,'{}')`,
        [projectId.replaceAll("-", "").repeat(2), runId, projectId],
      );
    });
    await page.goto("/?stage=Review");
    const reviewRow = page
      .getByTestId("desk-work")
      .getByTestId("work-row")
      .filter({ hasText: "Completion requires review" });

    await expect(reviewRow).toHaveAttribute("data-stage", "Review");
    await reviewRow.click();
    await expect(
      page.getByTestId("desk-work").getByText("A run hold is active."),
    ).toBeVisible();
    await page.goto(`/runs/${runId}`);
    await page.getByRole("button", { name: "Open inspector" }).click();
    const decisions = page.getByRole("region", { name: "Engine decisions" });

    await expect(
      decisions.getByText("Promotion · Requires attention"),
    ).toBeVisible();
    await expect(decisions.getByText("A run hold is active.")).toBeVisible();
  } finally {
    await withE2EDb((db) =>
      db.query("DELETE FROM projects WHERE id=$1", [projectId]),
    );
  }
});
