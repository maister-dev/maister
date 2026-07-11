import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// ADR-129 — the capability enforcement flip's run-detail UI surface. The
// `implement` ai_coding node declares `enforcement.tools: "strict"` with a
// `tools` allow-list, and the run is parked on a seeded `capability_guard`
// `hook_trip` HITL (an out-of-profile tool call that tripped the
// N-consecutive-deny breaker).
//
// This spec proves the ONE slice no other layer covers e2e: the
// `capability_guard` rule survives the FULL fan-out — supervisor
// `session.hook_trip{capability_guard}` → `hitl_requests` schema → run-detail
// card → localized label — and the resume round-trips a 2xx through the real
// respond route (REQ-21/22/24, AC-2/AC-7). This is exactly the fan-out the
// T5.5 grep-sentinel caught un-wired.
//
// Deliberately NOT asserted here (avoids overlap — already covered):
//  • the "Enforced" settings-panel VERDICT for the flipped `tools` class →
//    unit (`flow-settings-view.test.ts`, `flow-settings-panel.test.ts`); the
//    panel now lives behind the run-inspector Flow tab (a `<details>` summary,
//    not a load-visible heading), so re-driving it here would be brittle
//    overlap;
//  • the DYNAMIC trip DETECTION (in-profile allow / out-of-profile deny /
//    N-halt / evidence-gated launch refusal) → supervisor
//    guardrail-capability + guardrail-interceptor.integration + web
//    enforcement-profile/enforcement-evidence; the web e2e stub serves only
//    `GET /health` and cannot script tool-call streams (same boundary as
//    m40-guardrail-hooks.spec.ts);
//  • the strict-class launch REFUSAL → m11c-settings-enforcement.spec.ts
//    scenario B (`skills` stays instructed → CONFIG).
//
// Serial: the resume test CONSUMES the seeded hook_trip HITL the render test
// asserts on (parallel same-file workers would race the shared row).
test.describe.configure({ mode: "serial" });

test.describe("ADR-129 capability enforcement: capability_guard hook_trip surface", () => {
  test("capability_guard trip renders the hook_trip card with the localized rule + offending tool call", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.capabilityEnforcement;

    await page.goto(`/runs/${fx.runId}`);

    await expect(page.getByTestId("hook-trip-card")).toBeVisible();
    await expect(page.getByTestId("hook-trip-resume")).toBeVisible();
    await expect(page.getByTestId("hook-trip-abort")).toBeVisible();

    // The localized capability_guard rule label renders
    // (hookTripRule.capability_guard = "capability guard") — proof the rule
    // survived the full fan-out to the run-detail card.
    await expect(page.getByTestId("hook-trip-card")).toContainText(
      "capability guard",
    );
    // The out-of-profile offending tool call renders on its own line.
    await expect(page.getByTestId("hook-trip-tool-call")).toContainText(
      "WebFetch",
    );
  });

  test("resume routes a 2xx through the hook_trip respond endpoint", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.capabilityEnforcement;

    await page.goto(`/runs/${fx.runId}`);

    const resume = page.getByTestId("hook-trip-resume");

    await expect(resume).toBeVisible();

    const respond = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/runs/${fx.runId}/hitl/`) &&
        r.request().method() === "POST",
    );

    await resume.click();
    const res = await respond;

    // The respond route accepts the resume (2xx) and schedules the run-kind's
    // own resume in the background; the route returns before runFlow re-enters.
    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(300);
  });
});
