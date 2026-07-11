import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

function loadFixture(): { runId: string } {
  const fixtures = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m43Cutover: { runId: string } } };

  return fixtures.byKey.m43Cutover;
}

test("D2 history stays inspectable without resume or promotion controls", async ({
  page,
}) => {
  const fixture = loadFixture();

  await page.goto(`/runs/${fixture.runId}`);

  const banner = page.getByTestId("run-cutover-failure");

  await expect(banner).toBeVisible();
  await expect(banner).toContainText("engine 3.0");
  await expect(banner.locator("time")).toBeVisible();
  await expect(banner.getByRole("link", { name: /history/i })).toBeVisible();
  await expect(banner.getByRole("link", { name: /evidence/i })).toBeVisible();
  await expect(banner.getByRole("link", { name: /worktree/i })).toBeVisible();
  await expect(page.getByTestId("run-workbench")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /recover|resume|respond|promote|retry/i }),
  ).toHaveCount(0);
});
