import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withE2EDb } from "./_seed/db";

const projectId = randomUUID();
const slug = `vault-${projectId.slice(0, 8)}`;
const agentId = `fixture:${slug}`;
const href = `/projects/${slug}/agents/${encodeURIComponent(agentId)}?tab=memory`;

test.beforeAll(async () => {
  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1) ON CONFLICT DO NOTHING",
    );
    await pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ($1,$2,'Vault E2E',$3,$4)",
      [
        projectId,
        slug,
        `/tmp/${slug}`,
        `MV${projectId.slice(0, 7).toUpperCase()}`,
      ],
    );
    await pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
       VALUES ($1,'fixture','v1','git','Vault keeper','Vault fixture','none','session','[]','read_only','/unused/keeper.md')`,
      [agentId],
    );
    await pool.query(
      "INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled) VALUES ($1,$2,$3,true)",
      [randomUUID(), projectId, agentId],
    );
  });
});

test("AV-17 edits Markdown through Memory and restores a revision on a narrow screen", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseURL! },
  ]);
  await page.goto(href);
  const memory = page.getByRole("region", { name: "Memory vault" });

  await memory.getByRole("button", { name: "New note" }).click();
  let dialog = page.getByRole("dialog", { name: "New note" });

  await dialog
    .getByRole("textbox", { name: "Vault path" })
    .fill("/memories/index.md");
  await dialog
    .getByRole("textbox", { name: "Note Markdown" })
    .fill("# Initial note\nReference facts.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    memory.getByText("Reference facts.", { exact: false }),
  ).toBeVisible();
  await memory.getByRole("button", { name: "Edit note" }).click();
  dialog = page.getByRole("dialog", { name: "Edit note" });
  const source = dialog.getByRole("textbox", { name: "Note Markdown" });

  await expect(source).toBeFocused();
  await source.fill("# Updated note");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    memory.getByText("# Updated note", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: baseURL! },
  ]);
  await page.reload();
  const history = page.getByRole("region", { name: "История ревизий" });

  await expect(history.getByRole("link")).toHaveCount(2);
  await history.getByRole("link").last().click();
  await expect(
    page.getByText("Reference facts.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Восстановить ревизию" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить", exact: true })
    .click();
  await expect(history.getByRole("link")).toHaveCount(3);
  await expect(
    page.getByText("Reference facts.", { exact: false }),
  ).toBeVisible();
});
