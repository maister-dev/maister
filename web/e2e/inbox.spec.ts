import { test, expect } from "@playwright/test";

// Inbox card redesign: the full-bleed, project-grouped /inbox surface rendering
// the unified 3-tier HitlCard, plus the canonical "Needs you" badge fan-out.
// Relies on the shared seed having at least one pending cross-project HITL
// (the board / m17 fixtures seed NeedsInput runs), so needsYou > 0.

// The lazy expanded tier is asserted against a mocked inbox-context response so
// the gates/message/progress/diff render is deterministic regardless of the
// shared seed's per-run state.
const MOCK_INBOX_CONTEXT = {
  lastAgentMessage: {
    text: "Need a decision on the migration.",
    at: "2026-06-01T10:00:00.000Z",
  },
  gates: [
    {
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
    },
  ],
  diff: { files: 2, additions: 10, deletions: 3 },
  progress: { done: 1, total: 4 },
};

test.describe("Inbox card redesign", () => {
  test("the Inbox nav reaches /inbox and renders unified HITL cards", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator('nav[aria-label="Sections"] a[href="/inbox"]').click();

    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.getByTestId("hitl-card").first()).toBeVisible();
  });

  test("expanding a card lazily fetches and renders its decision context", async ({
    page,
  }) => {
    await page.route("**/api/runs/*/inbox-context", (route) =>
      route.fulfill({ json: MOCK_INBOX_CONTEXT }),
    );

    await page.goto("/inbox");

    const card = page.getByTestId("hitl-card").first();

    await expect(card).toBeVisible();
    // The collapsed card carries a View-run link to the run page.
    await expect(card.locator('a[href^="/runs/"]').first()).toBeVisible();

    // The header toggle drives the collapsed → expanded disclosure and the
    // lazy inbox-context fetch.
    const toggle = card.locator("button[aria-expanded]").first();

    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const contextResponse = page.waitForResponse("**/api/runs/*/inbox-context");

    await toggle.click();
    await contextResponse;

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The fetched context renders: a gate chip, the last agent message, the
    // done/total progress fraction, and the changes summary.
    await expect(card.getByText("lint")).toBeVisible();
    await expect(
      card.getByText("Need a decision on the migration."),
    ).toBeVisible();
    await expect(card.getByText("1 / 4")).toBeVisible();
    await expect(card.getByText(/2 files/)).toBeVisible();
  });

  test("a failed context load surfaces an error with a working retry", async ({
    page,
  }) => {
    let calls = 0;

    await page.route("**/api/runs/*/inbox-context", async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.fulfill({
          status: 500,
          json: { code: "CRASH", message: "boom" },
        });
      } else {
        await route.fulfill({ json: MOCK_INBOX_CONTEXT });
      }
    });

    await page.goto("/inbox");

    const card = page.getByTestId("hitl-card").first();
    const toggle = card.locator("button[aria-expanded]").first();

    await toggle.click();

    // The failed fetch shows the alert + retry control, not the context.
    const alert = card.getByRole("alert");

    await expect(alert).toBeVisible();
    await expect(card.getByText("lint")).toHaveCount(0);

    // Retry succeeds (second response is 200) and the context renders.
    await alert.getByRole("button").click();
    await expect(card.getByText("lint")).toBeVisible();
  });

  test("the rail badge and the home summary show the same canonical count", async ({
    page,
  }) => {
    await page.goto("/");

    const railBadge = page.getByTestId("inbox-nav-badge");
    const summaryCount = page.getByTestId("needs-you-count");

    await expect(railBadge).toBeVisible();
    await expect(summaryCount).toBeVisible();

    const rail = Number((await railBadge.textContent())?.trim());
    const summary = Number((await summaryCount.textContent())?.trim());

    expect(rail).toBeGreaterThan(0);
    expect(rail).toBe(summary);
  });
});
