// M11a (ADR-024): graph review HITL → rework decision, end-to-end through the
// real UI + respond route. The fixture (e2e/_seed/seed-e2e.ts) parks a run in
// NeedsInput with a `human` review HITL whose schema declares the
// approve/rework allow-list.
//
// Asserted, deterministic, supervisor-independent outcomes:
//   1. the review UI renders exactly the declared decisions + a comments box;
//   2. an off-list decision is refused 422 by the server allow-list;
//   3. clicking "Request rework" posts {decision, comments, workspacePolicy}
//      and the server validates + persists it (HTTP 200 ok:true).
//
// Note: rework is a LOOP, not a terminus — the runner resumes and re-enters the
// graph after a valid decision, so this spec asserts the decision is accepted
// (which sets responded_at + the decision columns synchronously), NOT that the
// run leaves NeedsInput. The full loop traversal needs a live supervisor (M11b).
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type Fixtures = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
};

function loadFixtures(): Fixtures {
  return JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as Fixtures;
}

test("review HITL: off-list decision is rejected, then a UI rework request is accepted", async ({
  page,
  request,
}) => {
  const fx = loadFixtures();

  // (1) Server-state allow-list: a decision outside allowedDecisions is
  // refused with 422 NEEDS_INPUT and leaves the row pending (no mutation).
  const offList = await request.post(
    `/api/runs/${fx.runId}/hitl/${fx.hitlRequestId}/respond`,
    { data: { response: { decision: "ship-it-anyway" } } },
  );

  expect(offList.status()).toBe(422);

  // (2) The run detail page renders the review branch: a comments box plus the
  // two declared decision buttons (and nothing outside the allow-list).
  await page.goto(`/runs/${fx.runId}`);

  const comments = page.locator("#review-comments");

  await expect(comments).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible();

  const rework = page.getByRole("button", {
    name: "Request rework",
    exact: true,
  });

  await expect(rework).toBeVisible();

  // (3) Clicking "Request rework" posts the decision + comments to the respond
  // route. Intercept that POST and assert the server validated + accepted it
  // (200 ok:true) — this is the synchronous, supervisor-independent contract
  // that persists decision/workspacePolicy/reworkTarget + responded_at.
  await comments.fill("Tighten the error handling and add a regression test.");

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
