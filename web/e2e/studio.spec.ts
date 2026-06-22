import { test, expect } from "@playwright/test";

// Phase A unified Studio shell. The seeded bootstrap admin reaches the renamed
// rail item, the overview, the grouped packages list, and the admin-only Sources
// surface. No package is seeded — the package-grouping + detail data walk is
// covered by unit tests (components/studio/*, lib/studio/*) and the install/
// attach path by package-management.spec.ts.
test("admin walks the Studio shell from the Flow Studio rail item", async ({
  page,
}) => {
  await page.goto("/");

  // The rail item is named "Flow Studio" and points at /studio.
  await page.locator('nav[aria-label="Sections"] a[href="/studio"]').click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Studio" }),
  ).toBeVisible();

  // The overview links into the grouped packages list.
  await page.locator('a[href="/studio/packages"]').first().click();
  await expect(page).toHaveURL(/\/studio\/packages$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Packages" }),
  ).toBeVisible();

  // Sources is admin-only and mounts the existing package-sources panel.
  await page.goto("/studio/sources");
  await expect(
    page.getByRole("heading", { name: "Package sources" }),
  ).toBeVisible();
});
