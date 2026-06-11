// ADR-075 social-board happy path: open the task page, post a comment that
// mentions EAB-42, see the comment with the expanded task link plus the
// activity rows, and the KEY-N chip on the board card. Fixture: the
// e2e-acceptance-board project carries the deterministic task key EAB and a
// second seeded task (seed-e2e.ts social-board block).

import { expect, test } from "@playwright/test";

const SLUG = "e2e-acceptance-board";

test("task page posts a comment with an expanded KEY-N mention; board shows the chip", async ({
  page,
}) => {
  await page.goto(`/projects/${SLUG}/tasks/1`);

  // Header identity: KEY-N chip + title.
  await expect(
    page.getByRole("heading", { name: "Acceptance backlog launch" }),
  ).toBeVisible();
  await expect(page.getByText("EAB-1", { exact: true })).toBeVisible();

  // Post a comment mentioning the second seeded task.
  const body = `Blocked until EAB-42 ships — see \`EAB-42\` (literal in code).`;

  await page.locator("#task-comment-body").fill(body);
  await page.getByRole("button", { name: /^(Comment|Комментировать)$/ }).click();

  // The stored body has the mention EXPANDED into a task link; the inline-code
  // occurrence stays literal text.
  const mentionLink = page.locator(
    `a[href="/projects/${SLUG}/tasks/42"]`,
    { hasText: "EAB-42" },
  );

  await expect(mentionLink.first()).toBeVisible();

  // The timeline shows the comment card. (Seeded tasks predate the domain
  // layer, so task 1 has no task_created activity row — activity is asserted
  // on task 2 below via the freshly written task_mentioned event.)
  await expect(
    page.locator('[data-timeline-kind="comment"]').last(),
  ).toContainText("Blocked until");

  // The mentioned task's page received the task_mentioned activity row.
  await page.goto(`/projects/${SLUG}/tasks/42`);
  await expect(
    page.getByRole("heading", { name: "Social mention target" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-timeline-kind="activity"]', { hasText: "EAB-1" }),
  ).toBeVisible();

  // Board card carries the KEY-N chip linking back to the task page.
  await page.goto(`/projects/${SLUG}`);
  await expect(page.getByText("EAB-1", { exact: true })).toBeVisible();
  await expect(page.getByText("EAB-42", { exact: true })).toBeVisible();
});
