import type { Page } from "@playwright/test";
import type { StubSessionRecord } from "./session-records";

import { expect } from "@playwright/test";

import { withE2EDb } from "./db";
import { readStubSessionRecords } from "./session-records";
import { STUB_SESSIONS_DIR } from "./stub-supervisor";
import { readTaskLaunchReceipt, waitForTaskLaunchRun } from "./task-launch";

export async function waitForSession(
  predicate: (record: StubSessionRecord) => boolean,
  timeoutMs = 30_000,
): Promise<StubSessionRecord> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const match = readStubSessionRecords(STUB_SESSIONS_DIR).find(predicate);

    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error("stub supervisor session record did not appear");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function launchTaskAgent(
  page: Page,
  agentId: string,
): Promise<StubSessionRecord> {
  await page
    .getByRole("main")
    .getByTestId("task-more-actions")
    .locator("> summary")
    .click();
  const picker = page.getByRole("combobox", { name: "Agent to run" });

  await expect(picker).toBeVisible();

  return withE2EDb(async (pool) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      // A different spec can edit global runners. The production admission
      // contract observes this catalog at preview, acceptance and dispatch.
      await client.query("LOCK TABLE platform_acp_runners IN SHARE MODE");
      await picker.selectOption(agentId);
      const accepted = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/task-launch-intents" &&
          response.request().method() === "POST",
      );

      await page.getByRole("button", { name: "Run agent" }).click();
      await page
        .getByRole("region", {
          name: "Launch this agent for the task",
          exact: true,
        })
        .getByRole("button", { name: "Launch", exact: true })
        .click();

      const receipt = await readTaskLaunchReceipt(await accepted);
      const runId = await waitForTaskLaunchRun(receipt);

      return await waitForSession(
        (record) => record.request.runId === runId && record.prompts.length > 0,
      );
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
  });
}
