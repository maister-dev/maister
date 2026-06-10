// ADR-071 (PR-grade review comments → rework loop): line-anchored comment
// threads on the review-gate diff, end-to-end through the real UI + the
// review-comments route family. The fixture (e2e/_seed/seed-e2e.ts,
// `byKey.reviewComments`) parks a run in NeedsInput at the graph `review`
// human gate with a REAL committed worktree diff (src/greeting.ts added on the
// run branch) and seeds:
//   • two OPEN inline roots whose stored line_content byte-matches the diff
//     (new-side lines 2 and 5; the first carries a reply);
//   • one OPEN root whose stored line_content mismatches → "outdated";
//   • a pending review HITL whose schema carries {maxLoops: 3, gateAttempt: 2}
//     so the loop chip renders (ADR-071 D5).
//
// Asserted, deterministic, supervisor-independent outcomes:
//   1. seeded state renders — loop chip + unresolved/outdated counts on the
//      gate panel, inline threads on their anchored diff lines, the outdated
//      thread in the collapsible Outdated section, and the approve soft-warn
//      while open threads exist (approve itself stays enabled — never blocked);
//   2. a NEW root comment lands through the diff add-widget composer
//      (POST 201 → thread renders, iteration badge = current gateAttempt,
//      panel count refreshes) and a reply lands through the reply affordance;
//   3. resolving a thread re-renders it resolved and decreases the count;
//   4. the rework decision posts through the gate panel and the server
//      validates + persists it (HTTP 200 ok:true).
//
// e2e honesty (plan risk note): the stub supervisor cannot run agents — this
// spec covers the UI surface + respond 200; the agent-receives-composed-prompt
// assertion lives in the runner integration tests (Task 7).
//
// ONE test, sequenced: the scenarios mutate one shared fixture run (counts,
// gate state), and `fullyParallel` would race them across workers otherwise.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

type ReviewCommentsFixture = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  filePath: string;
  inline: { line: number; body: string; reply: string };
  second: { line: number; body: string };
  outdated: { line: number; body: string; staleContent: string };
  composeLine: number;
  maxLoops: number;
  gateAttempt: number;
};

function loadFixture(): ReviewCommentsFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { reviewComments: ReviewCommentsFixture } };

  return all.byKey.reviewComments;
}

// Opens the inline composer on a NEW-side diff line: the gutter cell renders
// the lib's hover add-widget (`group-hover:visible`), so hover the cell first,
// then click the revealed "+" button.
async function openComposerOnNewLine(page: Page, line: number): Promise<void> {
  const gutterCell = page
    .locator('[data-testid="diff-view"] td.diff-line-new-num')
    .filter({ has: page.locator(`span[data-line-num="${line}"]`) })
    .first();

  await gutterCell.hover();
  await gutterCell.locator("button.diff-add-widget").click();
}

test("review gate: seeded threads render; add root + reply; resolve; rework decision accepted", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/runs/${fx.runId}`);

  // (1) Gate panel: the loop chip + counts computed server-side against the
  // live diff. Seeded: 3 open roots, 1 of them outdated (stale line_content).
  await expect(page.locator('[data-testid="review-loop-chip"]')).toHaveText(
    `Rework loop ${fx.gateAttempt} of ${fx.maxLoops + 1}`,
  );
  await expect(page.locator('[data-testid="review-open-count"]')).toHaveText(
    "3 unresolved",
  );
  await expect(
    page.locator('[data-testid="review-outdated-count"]'),
  ).toHaveText("1 outdated");

  // Approve soft-warn while open threads exist — and approve stays ENABLED
  // (the warn never blocks). Rework is NOT exhausted at visit 2 of 4.
  await expect(
    page.locator('[data-testid="review-approve-open-warn"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator('[data-testid="review-rework-exhausted"]'),
  ).toHaveCount(0);

  const rework = page.getByRole("button", {
    name: "Request rework",
    exact: true,
  });

  await expect(rework).toBeEnabled();

  // (1) The gate co-locates the diff; the seeded inline threads render on
  // their anchored lines (extendData stacks), tagged with visit 1.
  const gateDiff = page.locator('[data-testid="hitl-gate-diff"]');

  await expect(gateDiff).toBeVisible();
  const diffView = gateDiff.locator('[data-testid="diff-view"]');

  await expect(diffView).toBeVisible();
  await expect(diffView).toContainText("export function greet");
  await expect(
    gateDiff.locator('[data-testid="review-inline-threads"]'),
  ).toHaveCount(2);

  const inlineCard = page.locator('[data-testid="review-thread"]', {
    hasText: fx.inline.body,
  });

  await expect(inlineCard).toBeVisible();
  await expect(
    inlineCard.locator('[data-testid="review-iteration-badge"]'),
  ).toHaveText("1");
  await expect(
    inlineCard.locator('[data-testid="review-reply"]'),
  ).toContainText(fx.inline.reply);

  const secondCard = page.locator('[data-testid="review-thread"]', {
    hasText: fx.second.body,
  });

  await expect(secondCard).toBeVisible();

  // (1) The outdated seeded thread renders in the collapsible Outdated
  // section below the diff: file:line (side) + the quoted stale snapshot.
  const outdatedSection = page.locator('[data-testid="outdated-threads"]');

  await expect(outdatedSection).toBeVisible();
  await expect(outdatedSection.locator("summary")).toContainText(
    "Outdated comments (1)",
  );
  await outdatedSection.locator("summary").click();
  await expect(
    outdatedSection.locator('[data-testid="outdated-anchor"]'),
  ).toContainText(`${fx.filePath}:${fx.outdated.line} (new)`);
  await expect(
    outdatedSection.locator('[data-testid="outdated-quote"]'),
  ).toHaveText(fx.outdated.staleContent);
  await expect(
    outdatedSection.locator('[data-testid="review-thread"]', {
      hasText: fx.outdated.body,
    }),
  ).toBeVisible();

  // (2) ADD a root comment through the add-widget on the free diff line: the
  // composer opens in the widget row, the POST returns 201, the thread renders
  // stamped with the CURRENT visit, and the panel count refreshes.
  const newRootBody = "Please add a JSDoc comment for greet().";

  await openComposerOnNewLine(page, fx.composeLine);
  const widget = page.locator('[data-testid="review-widget"]');

  await expect(widget).toBeVisible();
  await widget
    .locator('[data-testid="review-composer-input"]')
    .fill(newRootBody);

  const createRootPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${fx.runId}/review-comments`) &&
      r.request().method() === "POST",
  );

  await widget.locator('[data-testid="review-composer-submit"]').click();
  expect((await createRootPromise).status()).toBe(201);

  const newCard = page.locator('[data-testid="review-thread"]', {
    hasText: newRootBody,
  });

  await expect(newCard).toBeVisible();
  await expect(
    newCard.locator('[data-testid="review-iteration-badge"]'),
  ).toHaveText(String(fx.gateAttempt));
  await expect(page.locator('[data-testid="review-open-count"]')).toHaveText(
    "4 unresolved",
  );

  // (2) REPLY to the new thread via the reply affordance on its card.
  const replyBody = "Reply: covered by the docs pass.";

  await newCard.locator('[data-testid="review-thread-reply"]').click();
  await newCard
    .locator('[data-testid="review-composer-input"]')
    .fill(replyBody);

  const createReplyPromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${fx.runId}/review-comments`) &&
      r.request().method() === "POST",
  );

  await newCard.locator('[data-testid="review-composer-submit"]').click();
  expect((await createReplyPromise).status()).toBe(201);
  await expect(newCard.locator('[data-testid="review-reply"]')).toContainText(
    replyBody,
  );

  // (3) RESOLVE the seeded second thread via the icon action: PATCH 200, the
  // card re-renders resolved (collapsed, chip), the count decreases after the
  // post-mutation refresh.
  const resolvePromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/runs/${fx.runId}/review-comments/`) &&
      r.request().method() === "PATCH",
  );

  await secondCard.locator('[data-testid="review-thread-resolve"]').click();
  expect((await resolvePromise).status()).toBe(200);

  const resolvedCard = page.locator(
    '[data-testid="review-thread"][data-status="resolved"]',
  );

  await expect(resolvedCard).toHaveCount(1);
  await expect(
    resolvedCard.locator('[data-testid="review-thread-resolved"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="review-open-count"]')).toHaveText(
    "3 unresolved",
  );

  // (4) The rework decision posts {decision, comments, workspacePolicy} to
  // the respond route and the server validates + accepts it (200 ok:true) —
  // the synchronous, supervisor-independent contract (the composed
  // comments-payload assertion lives in the runner integration tests).
  await page
    .locator("#hitl-review-comments")
    .fill("Apply the inline comments, then re-request review.");

  const respondPromise = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/runs/${fx.runId}/hitl/`) &&
      r.url().endsWith("/respond") &&
      r.request().method() === "POST",
  );

  await rework.click();

  const respond = await respondPromise;

  expect(respond.status()).toBe(200);

  const body = (await respond.json()) as { ok?: boolean };

  expect(body.ok).toBe(true);
});
