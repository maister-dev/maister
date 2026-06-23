import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// M40 / ADR-104 — the guardrail-hook `hook_trip` HITL surface (Phase 5/6).
//
// The web e2e supervisor stub cannot DYNAMICALLY trip a guardrail (it serves
// only `GET /health`; tool-call-stream scripting lives in the supervisor
// integration suite, not here), so each trip state is SEEDED directly — the
// same approach M17 uses to e2e the `human_review` HITL. This spec validates the
// rendered guardrail affordance + the resume/abort round-trip through the real
// respond route; the trip-DETECTION logic is covered by the supervisor
// guardrail-hooks unit/integration tests and the web hook-trip escalation
// integration tests. (The `path_guard` deny-and-continue rule has no web UI
// surface — it never escalates to a HITL — so it is unit/integration-only.)
//
// Serial: the resume/abort tests CONSUME the seeded hook_trip HITLs the render
// tests assert on (parallel same-file workers would race the shared rows).
test.describe.configure({ mode: "serial" });

test.describe("M40 guardrail hooks: hook_trip HITL surface + resume/abort", () => {
  test("repetition trip renders the guardrail card with the rule + offending tool call", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m40;

    await page.goto(`/runs/${fx.repetitionRunId}`);

    await expect(page.getByTestId("hook-trip-card")).toBeVisible();
    await expect(page.getByTestId("hook-trip-resume")).toBeVisible();
    await expect(page.getByTestId("hook-trip-abort")).toBeVisible();
    // The localized rule + the offending tool-call line both render.
    await expect(page.getByTestId("hook-trip-card")).toContainText(
      "repetition",
    );
    await expect(page.getByTestId("hook-trip-tool-call")).toContainText(
      "Edit src/app.ts",
    );
  });

  test("no_progress trip renders the card without an offending tool-call line", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m40;

    await page.goto(`/runs/${fx.noProgressRunId}`);

    await expect(page.getByTestId("hook-trip-card")).toBeVisible();
    await expect(page.getByTestId("hook-trip-card")).toContainText(
      "no progress",
    );
    // No toolCall in the seeded schema → the tool-call line is omitted.
    await expect(page.getByTestId("hook-trip-tool-call")).toHaveCount(0);
  });

  test("resume routes a 2xx through the hook_trip respond endpoint", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m40;

    await page.goto(`/runs/${fx.noProgressRunId}`);

    const resume = page.getByTestId("hook-trip-resume");

    await expect(resume).toBeVisible();

    const respond = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/runs/${fx.noProgressRunId}/hitl/`) &&
        r.request().method() === "POST",
    );

    await resume.click();
    const res = await respond;

    // The respond route accepts the resume (202) and schedules the run-kind's
    // own resume in the background; the route returns before runFlow re-enters.
    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(300);
  });

  test("abort terminates the run — the hook_trip card is consumed", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m40;

    await page.goto(`/runs/${fx.repetitionRunId}`);

    const abort = page.getByTestId("hook-trip-abort");

    await expect(abort).toBeVisible();

    const respond = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/runs/${fx.repetitionRunId}/hitl/`) &&
        r.request().method() === "POST",
    );

    await abort.click();
    const res = await respond;

    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(300);

    // Abort is a synchronous terminal transition (run → Failed) — no pending
    // hook_trip card remains after a reload.
    await page.reload();
    await expect(page.getByTestId("hook-trip-card")).toHaveCount(0);
  });
});
