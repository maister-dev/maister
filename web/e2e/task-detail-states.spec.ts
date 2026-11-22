// D10 task page (P-3, P-4, T-5 popover, S2 source chip). The state → action
// matrix is owned by lib/tasks/__tests__/task-next-action.test.ts; this spec
// samples one state per region and proves the on-demand/keyboard behavior.
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { seedDefaultRunSession, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

type Seeded = { number: number; runId: string; completedAt: string | null };

async function seedTask(status: "Backlog" | "Done"): Promise<Seeded> {
  const fx = loadFixtures().byKey.board;
  const suffix = randomUUID().slice(0, 8);
  const taskId = `task-d10-${suffix}`;
  const runId = `run-d10-${suffix}`;
  const number = (Number.parseInt(suffix, 16) % 900_000_000) + 100_000_000;

  const completedAt = await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage, attempt_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Backlog', 1)`,
      [
        taskId,
        fx.projectId,
        number,
        `D10 ${status} ${suffix}`,
        Array.from({ length: 12 }, (_, i) => `Statement line ${i + 1}`).join(
          "\n",
        ),
        fx.flowId,
        status,
      ],
    );
    if (status === "Backlog") return null;

    await pool.query(
      `INSERT INTO runs (id, run_kind, task_id, project_id, flow_id, status, flow_version, flow_revision,
         started_at, ended_at, delivery_policy_snapshot)
       VALUES ($1, 'flow', $2, $3, $4, 'Done', 'v1', 'rev-1', now() - interval '40 minutes', now() - interval '4 minutes',
         '{"strategy":"pull_request","push":"on_success","trigger":"manual","targetBranch":"main"}'::jsonb)`,
      [runId, taskId, fx.projectId, fx.flowId],
    );
    await seedDefaultRunSession(pool, {
      runId,
      runnerId: fx.runnerId,
      runnerResolutionTier: "project",
      capabilityAgent: "claude",
      runnerSnapshot: { model: "claude-sonnet-4-6" },
    });
    await pool.query(
      `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path,
         promotion_mode, promotion_state, pr_number, pr_url, pr_state)
       VALUES ($1, $2, $3, $4, $5, '/tmp/d10', 'pull_request', 'done', 7, 'https://github.com/acme/app/pull/7', 'merged')`,
      [
        `ws-${runId}`,
        runId,
        fx.projectId,
        `maister/d10-${suffix}`,
        `/tmp/d10-${suffix}`,
      ],
    );
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at, ended_at)
       VALUES ($1, $2, 'code', 'ai_coding', 1, 'succeeded', now() - interval '35 minutes', now() - interval '5 minutes')`,
      [`na-${runId}`, runId],
    );
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO task_activity (id, task_id, project_id, actor_type, event_kind, payload, created_at)
         VALUES ($1, $2, $3, 'system', 'run_launched', $4::jsonb, now() - interval '50 minutes' + ($5 || ' seconds')::interval)`,
        [
          `act-${runId}-${i}`,
          taskId,
          fx.projectId,
          JSON.stringify({ attemptNumber: i + 1 }),
          String(i),
        ],
      );
    }
    const completion = await pool.query<{ created_at: Date }>(
      `INSERT INTO task_activity (id, task_id, project_id, actor_type, event_kind, payload)
       VALUES ($1, $2, $3, 'system', 'task_completed', $4::jsonb)
       RETURNING created_at`,
      [
        `act-${runId}-done`,
        taskId,
        fx.projectId,
        JSON.stringify({ runId, cause: "pr_merged", prNumber: 7 }),
      ],
    );

    await pool.query(
      `INSERT INTO task_external_sources (id, project_id, task_id, source_kind, source_instance, scope_key,
         external_id, external_key, origin, created_by_actor_type)
       VALUES ($1, $2, $3, 'github', 'github.com', 'acme/app', $4, '#7', 'import', 'system')`,
      [`src-${runId}`, fx.projectId, taskId, `I_${suffix}`],
    );

    return completion.rows[0].created_at.toISOString();
  });

  return { number, runId, completedAt };
}

test.describe("task detail around state and result (D10)", () => {
  test("P-3: a Done task leads with its result, keeps a relaunch under More and loads graph and diff on demand", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Done");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const main = page.getByRole("main");

    const result = main.getByTestId("task-result-card");

    await expect(result).toContainText("Resolving run");
    await expect(result.getByRole("link", { name: "#7" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/7",
    );
    await expect(main.getByTestId("task-primary-action")).toContainText(
      "View result",
    );
    // S2: a binding without a URL renders as text, never a link.
    await expect(main.getByTestId("task-source-chip")).toHaveText("GitHub #7");
    await expect(main.locator('a[data-testid="task-source-chip"]')).toHaveCount(
      0,
    );
    // One relaunch entry, behind More.
    await main.getByTestId("task-more-actions").locator("> summary").click();
    await expect(
      main.getByRole("button", { name: /Start a new attempt/i }),
    ).toHaveCount(1);
    // A Done statement opens collapsed.
    await expect(main.getByTestId("task-statement")).not.toHaveAttribute(
      "open",
      "",
    );
    // The diff mounts only once opened.
    await expect(main.getByTestId("task-run-diff")).toHaveCount(0);
    await main.getByTestId("task-run-diff-toggle").click();
    await expect(main.getByTestId("task-run-diff")).toBeVisible();
  });

  test("P-3: a launchable Backlog task offers Launch first and triage under More", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Backlog");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const main = page.getByRole("main");

    await expect(
      main
        .getByTestId("task-primary-action")
        .getByRole("button", { name: /Launch/ }),
    ).toBeVisible();
    await main.getByTestId("task-more-actions").locator("> summary").click();
    await expect(
      main.getByRole("button", { name: "Send to triage" }),
    ).toBeVisible();
  });

  test("P-4: repetitive system events collapse into one row that keeps every entry", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Done");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const main = page.getByRole("main");

    const group = main.locator('[data-timeline-group="run_launched"]');

    await expect(group).toHaveCount(1);
    await expect(group).toContainText("×3");
    await group.locator("summary").click();
    for (const attempt of [1, 2, 3]) {
      await expect(group).toContainText(`launched run attempt ${attempt}`);
    }
  });

  test("T-5: the execution breakdown opens from the keyboard and closes on Escape", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Done");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const main = page.getByRole("main");

    const opener = main.getByTestId(
      `task-run-timing-${seeded.runId}-breakdown-open`,
    );

    const breakdown = page.getByTestId(
      `task-run-timing-${seeded.runId}-breakdown`,
    );

    // Exercise the hydrated control before sending a keyboard event.
    await opener.click();
    await expect(breakdown).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(breakdown).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.press("Enter");
    await expect(breakdown).toContainText("Execution");
    await page.keyboard.press("Escape");
    await expect(breakdown).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Tap (pointer) opens it as well.
    await opener.click();
    await expect(breakdown).toBeVisible();
  });
});

test.describe("T14 viewport, locale and theme (P-5)", () => {
  const timezoneId = "America/Los_Angeles";

  test.use({ hasTouch: true, timezoneId });

  const sizes = [
    { width: 1366, height: 768 },
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ];
  const resultLabel = { en: "View result", ru: "Посмотреть результат" };

  for (const viewport of sizes) {
    for (const locale of ["en", "ru"] as const) {
      for (const theme of ["light", "dark"] as const) {
        test(`${viewport.width}×${viewport.height}, ${locale}, ${theme}`, async ({
          page,
          baseURL,
        }) => {
          if (!baseURL) throw new Error("T14 requires the Playwright base URL");
          const fx = loadFixtures().byKey.board;
          const seeded = await seedTask("Done");

          await page.setViewportSize(viewport);
          await page.context().addCookies([
            { name: "NEXT_LOCALE", value: locale, url: baseURL },
            { name: "theme", value: theme, url: baseURL },
          ]);

          const main = page.getByRole("main");
          const root = page.locator("html");
          const instant = main.locator(
            `time[datetime="${seeded.completedAt}"]`,
          );
          const taskHref = `/projects/${fx.projectSlug}/tasks/${seeded.number}`;
          const runsHref = `/runs?project=${fx.projectSlug}`;

          await page.goto(taskHref);
          await expect(root).toHaveAttribute("lang", locale);
          await expect(root).toContainClass(theme);
          await expect(main.getByTestId("task-primary-action")).toContainText(
            resultLabel[locale],
          );
          await expect(instant).toHaveAttribute(
            "title",
            /\(America\/Los_Angeles\)$/,
          );
          const title = await instant.getAttribute("title");
          const taskTiming = main.getByTestId(
            `task-run-timing-${seeded.runId}`,
          );
          const duration = await taskTiming
            .locator("xpath=../preceding-sibling::td[1]")
            .innerText();
          const execution = await taskTiming
            .getByTestId(`task-run-timing-${seeded.runId}-execution`)
            .innerText();
          const tokenCell = taskTiming.locator(
            "xpath=../following-sibling::td[1]",
          );

          await expect(tokenCell).toHaveText("—");
          await expect(tokenCell).toHaveCSS("text-align", "right");
          await expect(tokenCell).toHaveCSS(
            "font-variant-numeric",
            "tabular-nums",
          );
          const opener = taskTiming.getByRole("button");

          if (viewport.width === 390) await opener.tap();
          else await opener.press("Enter");
          const breakdown = page.getByTestId(
            `task-run-timing-${seeded.runId}-breakdown`,
          );

          await expect(breakdown).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(breakdown).toBeHidden();

          for (const route of [taskHref, "/", "/activity", runsHref]) {
            await page.goto(route);
            const timestamp =
              route === "/" || route === "/activity"
                ? main
                    .getByTestId("activity-row")
                    .filter({ has: page.locator(`a[href="${taskHref}"]`) })
                    .locator(`time[datetime="${seeded.completedAt}"]`)
                : instant;

            await expect(timestamp, route).toHaveAttribute("title", title!);
            await expect
              .poll(
                () =>
                  page.evaluate(
                    () =>
                      document.documentElement.scrollWidth -
                      document.documentElement.clientWidth,
                  ),
                { message: route + " document overflow" },
              )
              .toBeLessThanOrEqual(1);
          }

          const runsTiming = main.getByTestId(`runs-timing-${seeded.runId}`);

          await expect(
            runsTiming.locator("xpath=../preceding-sibling::td[1]"),
          ).toHaveText(duration);
          await expect(
            runsTiming.getByTestId(`runs-timing-${seeded.runId}-execution`),
          ).toHaveText(execution);

          if (viewport.width === 1366 && locale === "en" && theme === "light") {
            await page
              .getByRole("button", { name: "Switch language to RU" })
              .click();
            // Changing locale renders the entire authenticated layout again.
            await expect(root).toHaveAttribute("lang", "ru", {
              timeout: 15_000,
            });
            await expect(instant).toHaveAttribute("title", /[а-я]/iu);
          }
        });
      }
    }
  }
});
