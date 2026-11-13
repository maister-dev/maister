import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

// `E2E-NAV-03` (ADR-172 D2): the portfolio moved from `/` to `/projects` and
// must render exactly what `/` rendered before — the same heading, the same
// project cards, the same onboarding checklist and the same decisions summary.
// A relocation that quietly drops one of those is the failure mode D2 names.
test("E2E-NAV-03 portfolio and project board expose seeded acceptance work", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;

  await page.goto("/projects");

  await expect(
    page.getByRole("heading", { name: "Projects", level: 1, exact: true }),
  ).toBeVisible();
  // exact:true targets the main-grid project link. The left rail (rendered at
  // md+) carries a "Start scratch workspace in E2E Acceptance Board" link whose
  // name contains this string, so a substring match resolves to two elements.
  await expect(
    page.getByRole("link", { name: "E2E Acceptance Board", exact: true }),
  ).toBeVisible();
  // The home "needs review" strip was removed in the project-grouped
  // active-workspaces redesign; home now exposes the seeded NeedsInput
  // workspace as a run row inside the project group.
  await expect(
    page.getByRole("link", { name: /acceptance-needs-input/ }).first(),
  ).toBeVisible();
  // WI-1: the portfolio collapses the cross-project HITL + social inbox into one
  // compact "Needs you" summary card (the full surfaces moved to /inbox).
  await expect(
    page.getByTestId("decisions-summary").filter({ visible: true }),
  ).toBeVisible();
  // The onboarding checklist is NOT asserted here. `OnboardingChecklist` returns
  // null once all three first-run steps are complete, and whether this shared
  // database has launched a task depends on which specs ran first — so the
  // assertion is order-dependent, not a fact about the move.
  // `E2E-EDGE-NAV-01` renders it for a
  // reader whose onboarding genuinely is incomplete.

  await page.goto(`/projects/${fx.projectSlug}`);

  await expect(
    page.getByRole("heading", { name: "E2E Acceptance Board" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "HITL inbox" })).toBeVisible();
  // The seeded HITL question surfaces in the board's inbox (the home strip
  // that used to carry it is gone).
  await expect(
    page.getByText("Acceptance review is waiting on you.").first(),
  ).toBeVisible();
  const board = page.getByRole("region", { name: "Task board", exact: true });

  await expect(board).toBeVisible();
  await expect(
    board.getByRole("link", { name: "Acceptance backlog launch", exact: true }),
  ).toBeVisible();
  await expect(board.locator('[data-stage="backlog"]')).toContainText(
    "Acceptance backlog launch",
  );
  await expect(board.locator('[data-stage="production"]')).toContainText(
    "Acceptance review pending",
  );

  await page.getByRole("tab", { name: /Activity/i }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await expect(page.getByText("Activity").first()).toBeVisible();

  await expect(page.getByRole("tab", { name: /PRs/i })).toHaveCount(0);
  await page.goto(`/projects/${fx.projectSlug}?tab=prs`);
  await expect(
    page.getByRole("region", { name: "Task board", exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /MCPs/i }).click();
  await expect(page).toHaveURL(/tab=mcps/);
  // The MCPs tab is the real project MCP catalog since M27 (ADR-070), not a
  // POC placeholder.
  await expect(
    page.getByRole("heading", { name: "Project MCP servers" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Packages/i }).click();
  await expect(page).toHaveURL(/tab=packages/);
  await expect(page.getByText("acceptance").first()).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/projects");

  const mobileNavTrigger = page.getByTestId("mobile-rail-toggle");

  await mobileNavTrigger.click();
  await expect(page.getByTestId("mobile-rail-drawer")).toBeVisible();
  await expect(
    page.getByTestId("mobile-rail-drawer").getByRole("link", {
      name: "Observatory",
    }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mobile-rail-drawer")).toHaveCount(0);
  await expect(mobileNavTrigger).toBeFocused();

  await mobileNavTrigger.click();
  await page
    .getByTestId("mobile-rail-drawer")
    .getByRole("link", { name: "Observatory" })
    .click();
  await expect(page).toHaveURL(/\/observatory$/);
  await expect(page.getByTestId("mobile-rail-drawer")).toHaveCount(0);
});

test("P1 keeps the closed project header the same with fifty retained working copies", async ({
  page,
}) => {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const slug = `compact-${projectId.slice(0, 8)}`;
  const title = "Canonical grouped task";

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO projects(id,slug,name,task_key,repo_path) VALUES($1,$2,'Compact project','CMPCT','/tmp/compact-project')",
      [projectId, slug],
    );
    await pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES($1,$2,1,$3,'Retained work')",
      [taskId, projectId, title],
    );
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/projects/${slug}`);
  const header = page.getByTestId("project-board-header");
  const board = page.getByRole("region", { name: "Task board", exact: true });
  const closed = async () => ({
    header: await header.boundingBox(),
    board: await board.boundingBox(),
  });

  await expect(header).toBeVisible();
  await expect(board).toBeVisible();
  const before = await closed();

  expect(before.header?.height).toBeLessThan(180);
  expect(before.board?.y).toBeLessThan(768);
  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO runs(id,project_id,task_id,run_kind,status,flow_version)
       SELECT $1 || '-' || g,$1,$2,'flow','Failed','v1' FROM generate_series(1,50) g`,
      [projectId, taskId],
    );
    await pool.query(
      `INSERT INTO workspaces(id,project_id,run_id,branch,worktree_path,parent_repo_path)
       SELECT id,$1,id,'copy-' || id,'/tmp/compact-' || id,'/tmp/compact-project' FROM runs WHERE project_id=$1`,
      [projectId],
    );
    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version) VALUES($1,$2,'flow','Running','v1')",
      [randomUUID(), projectId],
    );
  });
  await page.reload();

  await expect(header).toContainText("50");
  await expect(header).toContainText("1Executing");
  const after = await closed();

  expect(after.header?.height).toBe(before.header?.height);
  expect(after.board?.y).toBe(before.board?.y);
  await page.getByRole("link", { name: "Runs and working copies" }).click();
  const panel = page.getByTestId("project-workspaces");

  await expect(panel).toBeVisible();
  await panel.getByRole("link", { name: new RegExp(title) }).click();
  await expect(panel.getByRole("link", { name: /copy-/ })).toHaveCount(10);
  expect((await panel.boundingBox())?.height).toBeLessThan(420);
  await page.goBack();
  await expect(panel.getByRole("link", { name: /copy-/ })).toHaveCount(0);
  await page.goBack();
  await expect(panel).toHaveCount(0);
});
