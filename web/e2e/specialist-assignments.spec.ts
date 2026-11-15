import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

test.use({ actionTimeout: 15000 });
test.describe.configure({ mode: "serial" });

let assignmentId: string;
let otherAssignmentId: string;
let outsiderSecret: string;
const marker = randomUUID().slice(0, 8);
const objective = `Inspect the staging runbook ${marker}`;
const otherObjective = `Inspect the production runbook ${marker}`;

test.beforeAll(() => {
  const { adminEmail } = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { adminEmail: string };
  const home = path.resolve(`e2e/.runtime/specialist-home-${marker}`);

  mkdirSync(home, { recursive: true });
  // Domain code is server-only; seed it in a shimmed child process with a
  // disposable HOME for the fixture package cache.
  const output = execFileSync(
    path.resolve("node_modules/.bin/tsx"),
    [
      "--import",
      "./scripts/_register-shim.mjs",
      "e2e/_seed/seed-specialist-assignments.ts",
      adminEmail,
      marker,
      objective,
      otherObjective,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith('{"assignmentId"'));

  if (!line)
    throw new Error(`Specialist assignment seed printed no ids:\n${output}`);
  const seeded = JSON.parse(line) as {
    assignmentId: string;
    otherAssignmentId: string;
    outsiderSecret: string;
  };

  assignmentId = seeded.assignmentId;
  otherAssignmentId = seeded.otherAssignmentId;
  outsiderSecret = seeded.outsiderSecret;
});

test("E2E-CBU-02 lists, filters and opens accessible specialist work", async ({
  page,
}) => {
  await page.goto("/work");
  await page
    .getByRole("link", { name: "Specialist assignments", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Specialist assignments", exact: true }),
  ).toBeVisible();
  const table = page.getByTestId("specialist-assignments-table");

  await expect(table.getByRole("link", { name: objective })).toBeVisible();
  await page.locator('select[name="status"]').selectOption("cancelled");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/status=cancelled/);
  await expect(page.getByRole("link", { name: objective })).toHaveCount(0);
  await page.getByRole("link", { name: "Clear filters" }).click();
  await page.getByRole("link", { name: objective }).click();
  await expect(page).toHaveURL(
    new RegExp(`/specialist-assignments/${assignmentId}$`),
  );
  await expect(page.getByRole("heading", { name: objective })).toBeVisible();
  await expect(page.locator('[data-status="queued"]')).toHaveText("Queued");
  await expect(page.getByText("No work has been delegated yet.")).toBeVisible();
  await expect(page.getByText("Authority at submission")).toBeAttached();
});

test("E2E-CBU-02 cancels and reopens through confirmed, replay-safe controls", async ({
  page,
}) => {
  await page.goto(`/specialist-assignments/${assignmentId}`);
  await page
    .getByRole("button", { name: "Cancel assignment", exact: true })
    .click();
  const cancelDialog = page.getByRole("dialog", {
    name: "Cancel this assignment?",
  });

  await expect(
    cancelDialog.getByRole("button", { name: "Cancel assignment" }),
  ).toBeDisabled();
  await cancelDialog
    .getByLabel("Reason", { exact: true })
    .fill("The requester withdrew this check.");
  const cancelled = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/specialist-assignments/${assignmentId}/cancel` &&
      response.request().method() === "POST",
  );

  await cancelDialog.getByRole("button", { name: "Cancel assignment" }).click();
  expect((await cancelled).status()).toBe(200);
  await expect(page.locator('[data-status="cancelled"]')).toHaveText(
    "Cancelled",
  );
  await expect(page.getByText("Assignment cancelled").first()).toBeVisible();

  await page
    .getByRole("button", { name: "Reopen assignment", exact: true })
    .click();
  const reopenDialog = page.getByRole("dialog", {
    name: "Reopen this assignment?",
  });

  await reopenDialog
    .getByLabel("Reason", { exact: true })
    .fill("The check is needed again.");
  const reopened = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/specialist-assignments/${assignmentId}/continue` &&
      response.request().method() === "POST",
  );

  await reopenDialog.getByRole("button", { name: "Reopen assignment" }).click();
  expect((await reopened).status()).toBe(202);
  await expect(page.locator('[data-status="queued"]')).toHaveText("Queued");
});

test("E2E-CBU-02 hides an existing assignment from another user", async ({
  request,
}) => {
  const headers = { Authorization: `Bearer ${outsiderSecret}` };
  const detail = await request.get(
    `/api/v1/ext/specialist-assignments/${otherAssignmentId}`,
    { headers },
  );

  expect(detail.status()).toBe(404);
  const listed = await request.get(
    "/api/v1/ext/specialist-assignments?limit=50",
    {
      headers,
    },
  );

  expect(listed.status()).toBe(200);
  expect(
    ((await listed.json()) as { items: { id: string }[] }).items.map(
      ({ id }) => id,
    ),
  ).not.toContain(otherAssignmentId);
  const cancel = await request.post(
    `/api/v1/ext/specialist-assignments/${otherAssignmentId}/cancel`,
    {
      headers,
      data: {
        expectedRevision: 1,
        reason: "Not my assignment.",
        idempotencyKey: randomUUID(),
      },
    },
  );

  expect(cancel.status()).toBe(404);
});

test("E2E-CBU-02 renders the assignment screens in Russian", async ({
  page,
  context,
}) => {
  await page.goto("/specialist-assignments");
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: new URL(page.url()).origin },
  ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Поручения специалистам", exact: true }),
  ).toBeVisible();
  await page.goto(`/specialist-assignments/${otherAssignmentId}`);
  await expect(page.locator('[data-status="queued"]')).toHaveText("В очереди");
  await expect(
    page.getByRole("button", { name: "Отменить поручение", exact: true }),
  ).toBeVisible();
});
