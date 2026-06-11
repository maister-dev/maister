// M30 (ADR-078): gate-chat UI affordances on a parked review run.
//
// The seeded review fixtures carry NO acp_session_id (no live agent session
// in the supervisor-less e2e stack), so the DD2 availability predicate
// resolves to the EXPLANATORY EMPTY STATE — exactly the contract this spec
// pins: the panel always renders at a human/form pause, and an unavailable
// chat explains itself instead of failing or hiding. The full live/idle turn
// mechanics (L1/L2/L3, resume cost, revert notice) are covered by
// lib/services/__tests__/gate-chat.integration.test.ts and the supervisor
// readonly-turn suite.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type Fixtures = {
  byKey: {
    reviewComments: { runId: string; hitlRequestId: string };
  };
};

function loadFixtures(): Fixtures {
  return JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as Fixtures;
}

test("gate-chat renders the DD2 explanatory empty state when no agent session exists", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.reviewComments;

  await page.goto(`/runs/${fx.runId}`);

  const empty = page.locator('[data-testid="gate-chat-empty"]');

  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Chat unavailable");

  // Answer-only by construction: no input/send affordance in the empty state.
  await expect(page.locator('[data-testid="gate-chat-input"]')).toHaveCount(0);
});

test("the chat GET reports availability with a reason (API contract)", async ({
  request,
}) => {
  const fx = loadFixtures().byKey.reviewComments;

  const res = await request.get(
    `/api/runs/${fx.runId}/hitl/${fx.hitlRequestId}/chat`,
  );

  expect(res.status()).toBe(200);

  const body = (await res.json()) as {
    availability: { available: boolean; reason?: string };
    messages: unknown[];
  };

  expect(body.availability.available).toBe(false);
  expect(typeof body.availability.reason).toBe("string");
  expect(Array.isArray(body.messages)).toBe(true);
});
