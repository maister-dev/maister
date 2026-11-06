import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";
import type { Locator, Page } from "@playwright/test";

import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { readFakeGhState } from "./_seed/fake-gh";
import {
  seedManualTaskLaunchFixture,
  holdManualTaskLaunchRepository,
  MANUAL_QUALIFICATION_MARKER,
  MANUAL_REVIEW_MARKER,
  type ManualTaskLaunchFixture,
} from "./_seed/manual-task-launch";
import { STUB_SESSIONS_DIR } from "./_seed/stub-supervisor";
import { readStubSessionRecords } from "./_seed/session-records";

import { git } from "@/test-support/git-fixture";

type Task = Readonly<{ taskId: string; number: number; title: string }>;
let fixture: ManualTaskLaunchFixture;

test.describe("Manual task admission through the real browser and controlled provider boundaries", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });
  test.beforeEach(async () => {
    fixture = await seedManualTaskLaunchFixture();
  });
  test.afterEach(async ({ request, baseURL }) => {
    const intents = await withE2EDb(
      async (pool) =>
        (
          await pool.query<{ id: string; state_version: number }>(
            "SELECT id,state_version FROM task_launch_intents WHERE project_id=$1 AND state IN ('queued','preparing','held','run_bound') AND dispatch_committed_at IS NULL",
            [fixture.projectId],
          )
        ).rows,
    );

    for (const intent of intents) {
      const cancelled = await request.post(
        `/api/task-launch-intents/${intent.id}/cancel`,
        {
          headers: {
            Origin: new URL(baseURL!).origin,
            "Idempotency-Key": randomUUID(),
          },
          data: { expectedStateVersion: intent.state_version },
        },
      );

      expect([200, 409], await cancelled.text()).toContain(cancelled.status());
    }
    const active = await withE2EDb(
      async (pool) =>
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM runs WHERE project_id=$1 AND status IN ('Pending','Running','NeedsInput','NeedsInputIdle','HumanWorking','WaitingOnChildren')",
            [fixture.projectId],
          )
        ).rows,
    );

    for (const run of active) {
      const response = await request.post(`/api/runs/${run.id}/abandon`, {
        data: {},
      });

      expect([200, 409], await response.text()).toContain(response.status());
    }
  });

  test("LA01/02/10/12: configured manual Launch without qualification survives a lost receipt and delivers a checked, human-reviewed PR (controlled provider)", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await tickScheduler(page, "auto_promote");
    const settings = await page.request.patch(
      `/api/projects/${fixture.slug}/settings`,
      {
        data: {
          autoPromotion: {
            enabled: true,
            lanes: [
              {
                class: "docs",
                enabled: true,
                mode: "pull_request",
                delayMinutes: 0,
              },
            ],
          },
        },
      },
    );

    expect(settings.status()).toBe(200);
    const title = `Controlled manual PR ${fixture.taskKey}`;

    await page.goto(`/projects/${fixture.slug}`);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await page
      .locator('input[placeholder="Short summary of the task"]')
      .fill(title);
    await page
      .locator('textarea[placeholder="What should the agent do?"]')
      .fill(
        "Add the controlled documentation proof, verify it with the blocking check, and obtain human review before PR delivery.",
      );
    await page
      .getByRole("dialog")
      .getByLabel("Flow")
      .selectOption(fixture.flowId);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${fixture.slug}/tasks`) &&
        response.request().method() === "POST",
    );

    await page
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    const created = await createdResponse;

    expect(created.status()).toBe(201);
    const task = (await created.json()) as Pick<Task, "taskId" | "number">;
    const previewResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/runs/launch-options?") &&
        new URL(response.url()).searchParams.get("taskId") === task.taskId,
    );
    const dialog = await openLaunch(page, title);
    const preview = await previewResponse;

    expect(preview.status(), await preview.text()).toBe(200);
    await expect(dialog).toContainText(
      "No current assessment. Automatic execution requires accepted triage; you can launch this revision manually.",
    );
    await expect(page.getByTestId("task-qualification-dialog")).toHaveCount(0);
    await chooseLaunchOption(
      page,
      dialog,
      /Runner \/ Model/,
      new RegExp(fixture.runnerId),
    );
    const advanced = dialog.getByTestId("launch-advanced-options");

    await advanced.locator("> summary").click();
    await chooseLaunchOption(page, dialog, /Strategy/, /^Pull request$/);
    await chooseLaunchOption(page, dialog, /^.*Push$/, /^On success$/);
    await chooseLaunchOption(page, dialog, /Trigger/, /^Auto when ready$/);
    const before = await launchRows(task.taskId);

    expect(before).toEqual([]);
    const requests: Array<{ key: string | null; body: string | null }> = [];
    let originalReceipt: TaskLaunchReceipt | null = null;

    await page.route("**/api/task-launch-intents", async (route) => {
      requests.push({
        key: await route.request().headerValue("idempotency-key"),
        body: route.request().postData(),
      });
      const response = await route.fetch();

      expect(response.status()).toBe(202);
      if (requests.length === 1) {
        originalReceipt = (await response.json()) as TaskLaunchReceipt;
        await route.abort("failed");
      } else {
        await route.fulfill({ response });
      }
    });
    await dialog.getByRole("button", { name: "Launch", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "The response was lost.",
    );
    await page.route("**/api/attention/stream**", (route) =>
      route.abort("failed"),
    );
    await page.reload();
    const recovered = await openLaunch(page, title);

    await recovered
      .getByRole("button", { name: "Retry the same request", exact: true })
      .click();
    await expect(
      recovered.getByTestId("task-launch-intent-status"),
    ).toContainText("One manual launch is authorized for this revision.");
    await expect(recovered).toContainText(fixture.flowRef);
    await expect(recovered).toContainText(`${fixture.runnerId} · gpt-6.1-sol`);
    await expect(recovered).toContainText("Pull request");
    await expect(recovered).toContainText("Auto when ready");
    await expect(recovered.getByTestId("run-stream-liveness")).toHaveText(
      "Status disconnected",
      { timeout: 15_000 },
    );
    await page.unroute("**/api/attention/stream**");
    await recovered
      .getByRole("button", { name: "Reconnect", exact: true })
      .click();
    await expect(recovered.getByTestId("run-stream-liveness")).toHaveText(
      "Live",
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(originalReceipt).not.toBeNull();
    const rows = await launchRows(task.taskId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: originalReceipt!.intentId,
      basis: "manual",
    });
    await page.unroute("**/api/task-launch-intents");
    await expect
      .poll(async () => (await launchRows(task.taskId))[0]?.run_id, {
        timeout: 20_000,
      })
      .toEqual(expect.any(String));
    const runId = (await launchRows(task.taskId))[0].run_id!;

    await expect
      .poll(
        () =>
          withE2EDb(
            async (pool) =>
              (
                await pool.query(
                  "SELECT n.status,(SELECT status FROM gate_results g WHERE g.run_id=n.run_id AND g.gate_id='manual-launch-proof-check' ORDER BY g.created_at DESC LIMIT 1) AS check_status,(SELECT count(*)::int FROM hitl_requests h WHERE h.run_id=n.run_id AND h.responded_at IS NULL) AS open_reviews FROM node_attempts n WHERE n.run_id=$1 AND n.node_id='implement'",
                  [runId],
                )
              ).rows[0],
          ),
        { timeout: 20_000 },
      )
      .toMatchObject({
        status: "Succeeded",
        check_status: "passed",
        open_reviews: 1,
      });
    const sessions = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            "SELECT runner_id,runner_snapshot->>'model' AS model,runner_snapshot->>'adapter' AS adapter FROM run_sessions WHERE run_id=$1",
            [runId],
          )
        ).rows,
    );

    expect(sessions).toEqual([
      { runner_id: fixture.runnerId, model: "gpt-6.1-sol", adapter: "codex" },
    ]);
    const records = readStubSessionRecords(STUB_SESSIONS_DIR);

    expect(
      records.find((record) => record.request.runId === runId)?.request.runner,
    ).toMatchObject({
      runnerId: fixture.runnerId,
      model: "gpt-6.1-sol",
      adapter: "codex",
    });
    expect(
      readFakeGhState().prs.filter((pr) => pr.repoPath === fixture.repo),
    ).toEqual([]);
    await page.goto(`/runs/${runId}?wb=review&scope=review`);
    await expect(page.getByTestId("review-workspace")).toBeVisible();
    await expect(
      page.getByTestId("review-workspace").getByTestId("run-diff"),
    ).toContainText("manual-launch-proof.md");
    const approval = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/runs/${runId}/hitl/`) &&
        response.url().endsWith("/respond") &&
        response.request().method() === "POST",
    );

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    expect((await approval).status()).toBe(200);
    const reviewed = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            "SELECT response->>'decision' AS decision,responded_at IS NOT NULL AS responded FROM hitl_requests WHERE run_id=$1 AND step_id='review' AND kind='human'",
            [runId],
          )
        ).rows,
    );

    expect(reviewed).toEqual([{ decision: "approve", responded: true }]);
    await schedulerJob(page, "auto_promote");
    await expect
      .poll(
        () =>
          withE2EDb(
            async (pool) =>
              (
                await pool.query(
                  "SELECT r.status,w.pr_url,w.pr_number,w.published_branch,w.worktree_path,r.promoted_head_sha FROM runs r JOIN workspaces w ON w.run_id=r.id WHERE r.id=$1",
                  [runId],
                )
              ).rows[0],
          ),
        { timeout: 20_000 },
      )
      .toMatchObject({
        status: "Done",
        pr_url: expect.stringMatching(
          /^https:\/\/github\.com\/maister-e2e\/workbench-git\/pull\/\d+$/,
        ),
        published_branch: expect.any(String),
      });
    const delivered = await withE2EDb(
      async (pool) =>
        (
          await pool.query<{
            pr_url: string;
            pr_number: number;
            published_branch: string;
            worktree_path: string;
            promoted_head_sha: string;
            branch: string;
          }>(
            "SELECT w.pr_url,w.pr_number,w.published_branch,w.worktree_path,w.branch,r.promoted_head_sha FROM workspaces w JOIN runs r ON r.id=w.run_id WHERE w.run_id=$1",
            [runId],
          )
        ).rows[0],
    );
    const ownPr = readFakeGhState().prs.filter(
      (pr) => pr.repoPath === fixture.repo,
    );

    expect(ownPr).toEqual([
      expect.objectContaining({
        head: delivered.published_branch,
        base: "main",
        title: `MAIster: promote ${delivered.branch} → main`,
        draft: false,
        url: delivered.pr_url,
      }),
    ]);
    expect(
      await git(
        fixture.remote,
        "rev-parse",
        `refs/heads/${delivered.published_branch}`,
      ),
    ).toBe(delivered.promoted_head_sha);
    expect(
      await git(
        delivered.worktree_path,
        "show",
        "HEAD:docs/manual-launch-proof.md",
      ),
    ).toContain("Controlled provider output");
    await schedulerJob(page, "auto_promote");
    expect(
      readFakeGhState().creates.filter(
        (create) => create.head === delivered.published_branch,
      ),
    ).toHaveLength(1);
    expect(
      await withE2EDb(
        async (pool) =>
          (
            await pool.query(
              "SELECT id FROM task_qualifications WHERE task_id=$1",
              [task.taskId],
            )
          ).rows,
      ),
    ).toEqual([]);
  });

  test("LA03/05/08/10: RU manual launch after failed, negative and stale Triager preserves findings, holds edits, replaces and cancels queued intent", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "ru", url: baseURL! },
    ]);
    const failed = await createTask(
      page,
      "Failed Triager manual decision",
      MANUAL_QUALIFICATION_MARKER,
    );
    const negative = await createTask(
      page,
      "Negative Triager manual decision",
      `${MANUAL_QUALIFICATION_MARKER} ${MANUAL_REVIEW_MARKER}: acceptance criteria are explicitly unresolved.`,
    );
    const stale = await createTask(
      page,
      "Stale Triager manual decision",
      `${MANUAL_QUALIFICATION_MARKER}: exact current behavior and acceptance are specified.`,
    );

    const failedSource = await startQualifier(
      page,
      failed,
      baseURL!,
      fixture.failedRunnerId,
    );

    await expect
      .poll(
        () =>
          withE2EDb(
            async (pool) =>
              (
                await pool.query("SELECT status FROM runs WHERE id=$1", [
                  failedSource,
                ])
              ).rows[0].status,
          ),
        { timeout: 20_000 },
      )
      .toBe("Failed");
    await completeQualifier(page, negative, baseURL!);
    await completeQualifier(page, stale, baseURL!);
    await editPrompt(
      page,
      stale,
      `${MANUAL_QUALIFICATION_MARKER}: change the accepted input; the previous assessment must remain stale.`,
    );
    await page.goto(`/projects/${fixture.slug}/tasks/${failed.number}`);
    const failedAssessment = page.getByTestId("task-qualification");

    await expect(failedAssessment).toContainText(
      "Triager завершился ошибкой до публикации оценки.",
    );
    await expect(
      failedAssessment.getByRole("link", {
        name: "Открыть неудачный запуск Триажера",
        exact: true,
      }),
    ).toHaveAttribute("href", `/runs/${failedSource}`);
    const findings = await withE2EDb(
      async (pool) =>
        (
          await pool.query(
            "SELECT id,publication_state,value FROM task_qualifications WHERE task_id=ANY($1::text[]) ORDER BY id",
            [[failed.taskId, negative.taskId, stale.taskId]],
          )
        ).rows,
    );
    let fence: Awaited<
      ReturnType<typeof holdManualTaskLaunchRepository>
    > | null = null;

    await expect(async () => {
      fence = await holdManualTaskLaunchRepository(fixture.repo);
    }).toPass({ timeout: 10_000, intervals: [50, 100, 250] });
    if (!fence) throw new Error("The owned repository fence was not acquired");
    const ownedFence = fence as Awaited<
      ReturnType<typeof holdManualTaskLaunchRepository>
    >;
    let releaseObservation: () => void = () => {};
    const observationReleased = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    let holdFirstObservation = true;

    try {
      await page.route("**/api/task-launch-intents/*", async (route) => {
        if (holdFirstObservation && route.request().method() === "GET") {
          const actual = await route.fetch();
          const observed = (await actual.json()) as TaskLaunchReceipt;

          if (observed.taskId === failed.taskId) await observationReleased;
          await route.fulfill({ response: actual });

          return;
        }
        await route.continue();
      });
      for (const [task, copy] of [
        [failed, "Triager завершился ошибкой до публикации оценки."],
        [negative, "Триаж не рекомендует автоматическое выполнение."],
        [stale, "Оценка устарела. Автоматическое выполнение заблокировано;"],
      ] as const) {
        await page.goto(`/projects/${fixture.slug}`);
        const opener = launchControl(page, task.title);
        let dialog: Locator;

        if (task === failed) {
          await opener.focus();
          await expect(opener).toBeFocused();
          await page.keyboard.press("Enter");
          dialog = page.getByTestId("task-launch-dialog");
          await expect(dialog).toBeVisible();
          await expect(
            dialog.getByRole("button", { name: "Закрыть", exact: true }),
          ).toBeFocused();
        } else dialog = await openLaunch(page, task.title);

        await expect(dialog).toContainText(copy);
        await expect(page.getByTestId("task-qualification-dialog")).toHaveCount(
          0,
        );
        const accepted = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/task-launch-intents") &&
            response.request().method() === "POST",
        );

        const launch = dialog.getByRole("button", {
          name: "Запустить",
          exact: true,
        });

        await expect(launch).toBeEnabled();
        if (task === failed) {
          await page.keyboard.press("Shift+Tab");
          await expect(launch).toBeFocused();
          await page.keyboard.press("Enter");
        } else await launch.click();
        const response = await accepted;

        expect(response.status()).toBe(202);
        const receipt = (await response.json()) as TaskLaunchReceipt;
        let cancellationIntentId = receipt.intentId;

        await expect(dialog).toContainText(
          "Разрешён один ручной запуск этой редакции.",
        );
        expect(receipt.basis).toBe("manual");
        await expect(
          dialog.getByRole("status").filter({
            hasText:
              /Запуск принят — в очереди на подготовку|Подготовка выполнения/,
          }),
        ).toBeVisible();
        if (task === stale) {
          await editPrompt(
            page,
            task,
            `${MANUAL_QUALIFICATION_MARKER}: this edit happened while the manual request was queued.`,
          );
          await dialog
            .getByRole("button", { name: "Обновить статус", exact: true })
            .click();
          await expect(dialog).toContainText(
            "Запуск приостановлен — проверьте изменённый запрос",
          );
          await expect(dialog).toContainText(
            "Задача изменилась во время ожидания.",
          );
          await dialog
            .getByRole("button", { name: "Проверить и заменить", exact: true })
            .click();
          await expect(dialog).toContainText("Предыдущее разрешение: редакция");
          const replaced = page.waitForResponse(
            (result) =>
              result
                .url()
                .endsWith(
                  `/api/task-launch-intents/${receipt.intentId}/replace`,
                ) && result.request().method() === "POST",
          );

          await dialog
            .getByRole("button", { name: "Запустить", exact: true })
            .click();
          const replacementResponse = await replaced;

          expect(replacementResponse.status()).toBe(202);
          cancellationIntentId = (
            (await replacementResponse.json()) as TaskLaunchReceipt
          ).intentId;
          await expect(dialog).toContainText(
            "Разрешён один ручной запуск этой редакции.",
          );
          const lineage = await launchRows(task.taskId);

          expect(lineage).toHaveLength(2);
          expect(
            lineage.find((row) => row.id === receipt.intentId)?.state,
          ).toBe("cancelled");
        }
        await expect
          .poll(
            async () =>
              (await launchRows(task.taskId)).find(
                (row) => row.id === cancellationIntentId,
              ),
            { timeout: 20_000 },
          )
          .toMatchObject({
            state: "queued",
            reason: "operation_busy",
            run_id: null,
          });
        let staleCancellationKey: string | null = null;

        if (task === failed) {
          const staleCancellation = page.waitForResponse(
            (result) =>
              result
                .url()
                .endsWith(
                  `/api/task-launch-intents/${cancellationIntentId}/cancel`,
                ) && result.request().method() === "POST",
          );

          await dialog
            .getByRole("button", {
              name: "Отменить запуск в очереди",
              exact: true,
            })
            .click();
          const staleResponse = await staleCancellation;

          expect(staleResponse.status(), await staleResponse.text()).toBe(409);
          expect(await staleResponse.json()).toMatchObject({
            code: "CONFLICT",
            details: { reason: "launch_state_changed" },
          });
          expect(staleResponse.request().postDataJSON()).toEqual({
            expectedStateVersion: receipt.stateVersion,
          });
          staleCancellationKey = staleResponse.request().headers()[
            "idempotency-key"
          ];
          expect(staleCancellationKey).toEqual(expect.any(String));
          expect(staleCancellationKey).not.toBe("");
          await expect(dialog.getByRole("alert")).toContainText(
            "Состояние запуска изменилось. Обновите статус перед новым решением.",
          );
          holdFirstObservation = false;
          releaseObservation();
        }
        const refreshed = page.waitForRequest(
          (request) =>
            request.method() === "GET" &&
            request
              .url()
              .endsWith(`/api/task-launch-intents/${cancellationIntentId}`),
        );

        await dialog
          .getByRole("button", { name: "Обновить статус", exact: true })
          .click();
        const refreshResponse = await (await refreshed).response();

        expect(refreshResponse?.status()).toBe(200);
        const refreshedReceipt =
          (await refreshResponse!.json()) as TaskLaunchReceipt;

        expect(refreshedReceipt).toMatchObject({
          intentId: cancellationIntentId,
          state: "queued",
          reason: "operation_busy",
          runId: null,
        });
        await expect(dialog).toContainText(
          "Техническая проверка препятствует выполнению.",
        );
        const cancelled = page.waitForResponse(
          (result) =>
            result.url().includes("/api/task-launch-intents/") &&
            result.url().endsWith("/cancel") &&
            result.request().method() === "POST",
        );

        await dialog
          .getByRole("button", {
            name: "Отменить запуск в очереди",
            exact: true,
          })
          .click();
        const cancellationResponse = await cancelled;

        expect(
          cancellationResponse.status(),
          await cancellationResponse.text(),
        ).toBe(200);
        expect(
          cancellationResponse.request().postDataJSON().expectedStateVersion,
        ).toBeGreaterThanOrEqual(refreshedReceipt.stateVersion);
        if (task === failed) {
          expect(
            cancellationResponse.request().headers()["idempotency-key"],
          ).not.toBe(staleCancellationKey);
          expect(
            cancellationResponse.request().postDataJSON().expectedStateVersion,
          ).toBeGreaterThan(receipt.stateVersion);
        }
        await expect(dialog).toContainText("Запуск отменён");
        expect(
          (await launchRows(task.taskId)).every(
            (row) =>
              row.state === "cancelled" &&
              row.basis === "manual" &&
              row.run_id === null,
          ),
        ).toBe(true);
        if (task === failed) {
          await page.keyboard.press("Escape");
          await expect(dialog).not.toBeVisible();
          await expect(opener).toBeFocused();
        }
      }
    } finally {
      holdFirstObservation = false;
      releaseObservation();
      try {
        await page.unroute("**/api/task-launch-intents/*");
      } finally {
        await ownedFence.release();
      }
    }
    expect(
      await withE2EDb(
        async (pool) =>
          (
            await pool.query(
              "SELECT id,publication_state,value FROM task_qualifications WHERE task_id=ANY($1::text[]) ORDER BY id",
              [[failed.taskId, negative.taskId, stale.taskId]],
            )
          ).rows,
      ),
    ).toEqual(findings);
  });
});

function launchControl(page: Page, title: string): Locator {
  const card = page
    .locator("[data-board]")
    .getByText(title, { exact: true })
    .locator("xpath=ancestor::article");

  return card
    .getByRole("button", {
      name: /^(Launch|Run again|Запустить|Запустить снова)$/,
    })
    .first();
}

async function openLaunch(page: Page, title: string): Promise<Locator> {
  await launchControl(page, title).click();
  const dialog = page.getByTestId("task-launch-dialog");

  await expect(dialog).toBeVisible();

  return dialog;
}

async function chooseLaunchOption(
  page: Page,
  dialog: Locator,
  label: RegExp,
  option: RegExp,
): Promise<void> {
  await dialog.getByRole("button", { name: label }).first().click();
  await page.getByRole("option", { name: option }).click();
}

async function createTask(
  page: Page,
  title: string,
  prompt: string,
): Promise<Task> {
  const response = await page.request.post(
    `/api/projects/${fixture.slug}/tasks`,
    { data: { title, prompt, flowId: fixture.flowId } },
  );

  expect(response.status()).toBe(201);
  const task = (await response.json()) as Omit<Task, "title">;
  const configured = await page.request.patch(
    `/api/projects/${fixture.slug}/tasks/${task.number}`,
    { data: { runnerId: fixture.runnerId, expectedRevision: 0 } },
  );

  expect(configured.status()).toBe(200);

  return { ...task, title };
}

async function editPrompt(
  page: Page,
  task: Task,
  prompt: string,
): Promise<void> {
  const response = await page.request.get(
    `/api/runs/launch-options?taskId=${task.taskId}`,
  );

  expect(response.status()).toBe(200);
  const preview = (await response.json()) as { task: { revision: number } };
  const edited = await page.request.patch(
    `/api/projects/${fixture.slug}/tasks/${task.number}`,
    { data: { prompt, expectedRevision: preview.task.revision } },
  );

  expect(edited.status()).toBe(200);
}

async function startQualifier(
  page: Page,
  task: Task,
  baseURL: string,
  runnerId?: string,
): Promise<string> {
  const response = await page.request.post(
    `/api/projects/${fixture.slug}/agents/${encodeURIComponent(fixture.qualifierId)}/launch`,
    {
      headers: { Origin: new URL(baseURL).origin },
      data: { taskId: task.taskId, ...(runnerId ? { runnerId } : {}) },
    },
  );

  expect(response.status()).toBe(202);
  const { runId } = (await response.json()) as { runId: string };

  return runId;
}

async function completeQualifier(
  page: Page,
  task: Task,
  baseURL: string,
): Promise<void> {
  const runId = await startQualifier(page, task, baseURL);

  await expect
    .poll(
      () =>
        withE2EDb(
          async (pool) =>
            (
              await pool.query(
                "SELECT count(*)::int n FROM task_qualifications WHERE author_run_id=$1 AND publication_state='candidate'",
                [runId],
              )
            ).rows[0].n,
        ),
      { timeout: 20_000 },
    )
    .toBe(1);
  await writeFile(
    `${STUB_SESSIONS_DIR}/${runId}.qualification-release`,
    "release",
  );
  await expect
    .poll(
      () =>
        withE2EDb(
          async (pool) =>
            (await pool.query("SELECT status FROM runs WHERE id=$1", [runId]))
              .rows[0].status,
        ),
      { timeout: 20_000 },
    )
    .toBe("Done");
}

async function launchRows(taskId: string): Promise<
  Array<{
    id: string;
    basis: string;
    state: string;
    reason: string | null;
    run_id: string | null;
  }>
> {
  return withE2EDb(
    async (pool) =>
      (
        await pool.query<{
          id: string;
          basis: string;
          state: string;
          reason: string | null;
          run_id: string | null;
        }>(
          "SELECT id,basis->>'kind' AS basis,state,reason,run_id FROM task_launch_intents WHERE task_id=$1 ORDER BY accepted_at",
          [taskId],
        )
      ).rows,
  );
}

async function schedulerJob(page: Page, kind: "auto_promote"): Promise<void> {
  const due = await page.request.patch(
    `/api/admin/scheduler-jobs/${kind}.default`,
    { data: { nextRunAt: new Date(0).toISOString(), enabled: true } },
  );

  expect(due.status(), await due.text()).toBe(200);
  await tickScheduler(page, kind);
}

async function tickScheduler(page: Page, kind: "auto_promote"): Promise<void> {
  const tick = await page.request.post(`/api/cron/tick?jobKind=${kind}`, {
    headers: {
      Authorization: `Bearer ${process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me"}`,
    },
  });

  expect(tick.ok(), await tick.text()).toBe(true);
}
