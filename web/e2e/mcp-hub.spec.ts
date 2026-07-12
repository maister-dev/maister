import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// ADR-129 (W-D, T6.5): the project MCP hub end-to-end. Drives the board
// `?tab=mcps` write surfaces through the app as the seeded admin: catalog a
// platform MCP, make it trusted (T6.4 — connect-as-executable requires trust),
// connect it into a project, watch the requirements ledger classify it `bound`
// (T6.2), then disconnect it back to an `unbound` opt-out. The bind→launch→
// `provenance:'binding'` path is covered by the real-Postgres integration suite
// (T2.6); this spec pins the UI wiring the integration tests can't see. The stub
// supervisor has no `/mcp-probe`, so we assert the Test-connection affordance is
// present rather than driving a live probe.

const MCP_ID = "e2e-hub-github";

test("admin catalogs, trusts, connects and disconnects a platform MCP via the hub", async ({
  page,
}) => {
  const board = loadFixtures().byKey.board;

  // --- Catalog a stdio platform MCP server (admin /mcps, mirrors m27).
  await page.goto("/mcps");
  await expect(
    page.getByRole("heading", { level: 1, name: "MCP servers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add MCP server" }).click();

  const modal = page.getByRole("dialog");

  await expect(modal).toBeVisible();
  await modal.getByLabel("Server id").fill(MCP_ID);
  await modal.getByLabel("Command").fill("e2e-hub-cmd");
  await modal.getByRole("button", { name: "Save" }).click();

  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: MCP_ID }) });

  await expect(row).toBeVisible();

  // --- Trust it (T6.4). A freshly-catalogued server defaults untrusted; the
  // connect-as-executable guard (CONFLICT) refuses an untrusted platform target.
  await row.getByRole("button", { name: "Needs trust" }).click();
  await expect(row.getByRole("button", { name: "Trusted" })).toBeVisible();

  // --- Connect it into the project through the board MCP tab (T6.2).
  await page.goto(`/projects/${board.projectSlug}?tab=mcps`);
  await page.getByTestId("mcp-connect-select").selectOption(MCP_ID);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // The connected ref shows in the requirements ledger, classified `bound`.
  await expect(page.getByTestId(`mcp-req-${MCP_ID}`)).toBeVisible();
  await expect(page.getByTestId(`mcp-req-class-${MCP_ID}`)).toHaveText("bound");
  await expect(
    page
      .getByTestId(`mcp-req-${MCP_ID}`)
      .getByRole("button", { name: "Test connection" }),
  ).toBeVisible();

  // --- Disconnect — the binding becomes a disabled opt-out (`unbound`).
  await page
    .getByTestId(`mcp-req-${MCP_ID}`)
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(page.getByTestId(`mcp-req-class-${MCP_ID}`)).toHaveText(
    "unbound",
  );
});
