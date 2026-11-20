import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test.use({ actionTimeout: 15000 });
test.describe.configure({ mode: "serial" });

let assignmentId: string;
let otherAssignmentId: string;
let outsiderSecret: string;
let installationBindingId: string;
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
      loadFixtures().users.member.id,
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
    installationBindingId: string;
  };

  assignmentId = seeded.assignmentId;
  otherAssignmentId = seeded.otherAssignmentId;
  outsiderSecret = seeded.outsiderSecret;
  installationBindingId = seeded.installationBindingId;
});

test("AV-06 administers installation reach and restores access to retained Memory", async ({
  page,
  context,
  baseURL,
  browser,
}) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseURL! },
  ]);
  const configuration = `/settings/specialists?binding=${installationBindingId}`;
  const edit = `${configuration}&edit=installation`;
  const memoryPage = `${configuration}&tab=memory`;

  await page.goto(memoryPage);
  const memory = page.getByRole("region", { name: "Memory vault" });

  await expect(memory.locator('a[href*="#knowledge-memory"]')).toHaveAttribute(
    "href",
    /kind=vault/,
  );
  await memory.getByRole("button", { name: "New note" }).click();
  const note = page.getByRole("dialog", { name: "New note" });

  await note
    .getByRole("textbox", { name: "Vault path" })
    .fill("/memories/index.md");
  await note
    .getByRole("textbox", { name: "Note Markdown" })
    .fill("Retained installation note.");
  await note.getByRole("button", { name: "Save", exact: true }).click();
  await expect(memory.getByText("Retained installation note.")).toBeVisible();

  await page.goto(edit);
  const form = page.locator("form").filter({
    has: page.getByRole("heading", { name: "Edit installation binding" }),
  });

  await form.getByRole("checkbox", { name: "Installation reach" }).uncheck();
  await form.getByRole("button", { name: "Save reviewed binding" }).click();
  await expect(form.getByRole("status")).toHaveText("Reviewed binding saved.");
  await page.goto(configuration);
  await expect(page.getByRole("link", { name: "Memory vault" })).toHaveCount(0);
  await page.getByRole("link", { name: "Edit installation binding" }).click();
  await form.getByRole("checkbox", { name: "Installation reach" }).check();
  await form.getByRole("checkbox", { name: "Memory vault" }).check();
  await form.getByRole("checkbox", { name: "agent_memory:read" }).check();
  await form.getByRole("button", { name: "Save reviewed binding" }).click();
  await expect(form.getByRole("status")).toHaveText("Reviewed binding saved.");
  await page.getByRole("link", { name: "Memory vault" }).click();
  await memory.getByRole("link", { name: "index.md" }).click();
  await expect(memory.getByText("Retained installation note.")).toBeVisible();

  const managerContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });

  try {
    await managerContext.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    const manager = await managerContext.newPage();
    const user = loadFixtures().users.member;

    await manager.goto("/login");
    await manager.locator('input[name="email"]').fill(user.email);
    await manager.locator('input[name="password"]').fill(user.password);
    await manager.locator('form button[type="submit"]').click();
    await manager.waitForURL((url) => !url.pathname.startsWith("/login"));
    await manager.goto(edit);
    await expect(
      manager.getByRole("heading", { name: "Review new specialist binding" }),
    ).toBeVisible();
    await expect(
      manager.getByRole("checkbox", { name: "Installation reach" }),
    ).toHaveCount(0);
    await expect(
      manager.getByRole("link", { name: "Edit installation binding" }),
    ).toHaveCount(0);
  } finally {
    await managerContext.close();
  }
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
  await expect(
    page.getByRole("main").locator('[data-status="queued"]'),
  ).toHaveText("Queued");
  await expect(page.getByText("No work has been delegated yet.")).toBeVisible();
  await expect(page.getByText("Authority at submission")).toBeAttached();
});

test("E2E-CBU-02 cancels through confirmed controls and directs follow-up to the retained work", async ({
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
  await expect(
    page.getByRole("main").locator('[data-status="cancelled"]'),
  ).toHaveText("Cancelled");
  await expect(page.getByText("Assignment cancelled").first()).toBeVisible();

  await expect(
    page.getByText(
      "Reconcile any unresolved Stand operation and finish any Run in Review before submitting a new assignment.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reopen assignment" }),
  ).toHaveCount(0);
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
  // A freshly loaded page can briefly hold a hidden second copy outside
  // <main> (web/CLAUDE.md), so read the status chip inside it.
  await expect(
    page.getByRole("main").locator('[data-status="queued"]'),
  ).toHaveText("В очереди");
  await expect(
    page.getByRole("button", { name: "Отменить поручение", exact: true }),
  ).toBeVisible();
});
