import { test, expect } from "@playwright/test";

// M27/T-C2: the admin can create, edit, and delete a platform MCP server via the
// /settings UI — mirrors platform-acp-runners.spec.ts (the CRUD + modal flow).
test("admin can create, edit, and delete a platform MCP server via settings", async ({
  page,
}) => {
  const mcpId = "e2e-temp-mcp";

  await page.goto("/settings");

  await expect(
    page.getByRole("heading", { name: "MCP servers" }),
  ).toBeVisible();

  // --- Create: open the modal, fill a stdio server (default transport).
  await page.getByRole("button", { name: "Add MCP server" }).click();

  const modal = page.getByRole("dialog");

  await expect(modal).toBeVisible();
  await modal.getByLabel("Server id").fill(mcpId);
  await modal.getByLabel("Command").fill("e2e-mcp-cmd");
  await modal.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("cell", { name: mcpId })).toBeVisible();
  await expect(page.getByRole("cell", { name: "e2e-mcp-cmd" })).toBeVisible();

  // --- Edit: reopen, change the command, expect the new value in-row.
  const createdRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: mcpId }) });

  await createdRow.getByRole("button", { name: "Edit" }).click();

  const editModal = page.getByRole("dialog");

  await expect(editModal).toBeVisible();
  await editModal.getByLabel("Command").fill("e2e-mcp-cmd-edited");
  await editModal.getByRole("button", { name: "Save" }).click();

  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: mcpId }) })
      .getByRole("cell", { name: "e2e-mcp-cmd-edited" }),
  ).toBeVisible();

  // --- Delete: unreferenced server → the 204 path removes the row. Two-click:
  // first arms the confirm gate, second sends the DELETE.
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: mcpId }) })
    .getByRole("button", { name: "Edit" })
    .click();

  const deleteModal = page.getByRole("dialog");

  await expect(deleteModal).toBeVisible();
  await deleteModal
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await deleteModal
    .getByRole("button", { name: /Delete this MCP server/ })
    .click();

  await expect(page.getByRole("cell", { name: mcpId })).toHaveCount(0);
});
