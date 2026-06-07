import { test, expect } from "@playwright/test";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

const SLUG = "e2e-acceptance-board";

test("members panel renders on the members tab", async ({ page }) => {
  await page.goto(`/projects/${SLUG}?tab=members`);
  await expect(
    page.getByRole("heading", { name: "Team members" }),
  ).toBeVisible();
});

// add → change role → remove must run in order: each step depends on the
// previous one having written state to the shared e2e DB.
test.describe("member lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  test("add an existing user as a member", async ({ page }) => {
    const { users, byKey } = loadFixtures();
    const { projectId } = byKey.board;

    await page.goto(`/projects/${SLUG}?tab=members`);
    await expect(
      page.getByRole("heading", { name: "Team members" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add member" }).click();

    const dialog = page.getByRole("dialog");

    await expect(dialog).toBeVisible();

    // Search for the candidate.
    await dialog
      .getByPlaceholder("Search by name or email…")
      .fill(users.memberCandidate.email);

    // Wait for the candidate to appear and click it.
    await expect(dialog.getByText(users.memberCandidate.email)).toBeVisible();
    await dialog.getByText(users.memberCandidate.email).click();

    // Choose role member.
    await dialog.getByLabel("Role").selectOption("member");

    // Save.
    await dialog.getByRole("button", { name: "Add member" }).click();
    await expect(dialog).toBeHidden();

    // DB assertion: project_members row exists with role member.
    const role = await singleValue<string>(
      `SELECT pm.role AS value
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND u.email = $2`,
      [projectId, users.memberCandidate.email],
    );
    const addedBy = await singleValue<string>(
      `SELECT pm.added_by AS value
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND u.email = $2`,
      [projectId, users.memberCandidate.email],
    );

    expect(role).toBe("member");
    expect(addedBy).not.toBeNull();
  });

  test("change a member's role", async ({ page }) => {
    const { users, byKey } = loadFixtures();
    const { projectId } = byKey.board;

    await page.goto(`/projects/${SLUG}?tab=members`);
    await expect(
      page.getByRole("heading", { name: "Team members" }),
    ).toBeVisible();

    // Open the Change role dialog for the memberCandidate.
    await page
      .getByRole("button", {
        name: `Change role · ${users.memberCandidate.name}`,
      })
      .click();

    const dialog = page.getByRole("dialog");

    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Change role" }),
    ).toBeVisible();

    await dialog.getByLabel("Role").selectOption("admin");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    // DB assertion: role updated to admin.
    const role = await singleValue<string>(
      `SELECT pm.role AS value
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND u.email = $2`,
      [projectId, users.memberCandidate.email],
    );
    const updatedBy = await singleValue<string>(
      `SELECT pm.updated_by AS value
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND u.email = $2`,
      [projectId, users.memberCandidate.email],
    );

    expect(role).toBe("admin");
    expect(updatedBy).not.toBeNull();
  });

  test("remove a member", async ({ page }) => {
    const { users, byKey } = loadFixtures();
    const { projectId } = byKey.board;

    await page.goto(`/projects/${SLUG}?tab=members`);
    await expect(
      page.getByRole("heading", { name: "Team members" }),
    ).toBeVisible();

    // Open the Remove dialog for the memberCandidate.
    await page
      .getByRole("button", {
        name: `Remove · ${users.memberCandidate.name}`,
      })
      .click();

    const dialog = page.getByRole("dialog");

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Remove" })).toBeVisible();

    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog).toBeHidden();

    // DB assertion: no project_members row.
    const count = await withE2EDb(async (pool) => {
      const res = await pool.query<{ value: string }>(
        `SELECT count(*)::text AS value
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1 AND u.email = $2`,
        [projectId, users.memberCandidate.email],
      );

      return Number(res.rows[0]?.value ?? 0);
    });

    expect(count).toBe(0);
  });
});
