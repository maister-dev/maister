// M34 (ADR-089) e2e (a): manual catalog launch from the task detail page.
// "Run agent" POSTs /api/projects/{slug}/agents/{id}/launch → an agent-kind
// run spins up against the stub supervisor (a real /sessions round-trip:
// createSession → prompt → SSE), the project page shows the run in the active
// grid with the agent + trigger chip, and after the spec releases the held
// stub stream the run finalizes Done at the terminal choke point.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { STUB_SESSIONS_DIR } from "./_seed/stub-supervisor";

type SessionRecord = {
  sessionId: string;
  request: { runId?: string; readOnlySession?: boolean };
  prompts: Array<{ prompt: string }>;
};

function readSessionRecords(): SessionRecord[] {
  if (!existsSync(STUB_SESSIONS_DIR)) return [];

  return readdirSync(STUB_SESSIONS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(
          readFileSync(path.join(STUB_SESSIONS_DIR, name), "utf8"),
        ) as SessionRecord,
    );
}

async function waitForSession(
  predicate: (record: SessionRecord) => boolean,
  timeoutMs = 30_000,
): Promise<SessionRecord> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const match = readSessionRecords().find(predicate);

    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error("stub supervisor session record did not appear");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function releaseSession(sessionId: string): void {
  writeFileSync(
    path.join(STUB_SESSIONS_DIR, `${sessionId}.release`),
    "go",
    "utf8",
  );
}

test("manual agent launch: run visible with the agent chip, then finalizes Done", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.platformAgents;

  await page.goto(`/projects/${fx.projectSlug}/tasks/${fx.manualTaskNumber}`);
  await expect(
    page.getByRole("combobox", { name: "Agent to run" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Agent to run" })
    .selectOption(fx.helperAgentId);

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/agents/${fx.helperAgentId}/launch`) &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Run agent" }).click();

  const response = await launchResponse;

  expect(response.status()).toBe(202);

  const { runId } = (await response.json()) as { runId: string };

  // The stub recorded the spawn: a read-only session (workspace=none ⇒ L1)
  // whose prompt carries the agent.md body marker.
  const session = await waitForSession(
    (record) => record.request.runId === runId,
  );

  expect(session.request.readOnlySession).toBe(true);

  // While the stub holds the stream open the run is live — the project page
  // shows it in the active grid with the agent kind + trigger chip.
  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(page.getByText("agent · manual")).toBeVisible();

  releaseSession(session.sessionId);

  await expect
    .poll(
      () =>
        singleValue<string>(`SELECT status AS value FROM runs WHERE id = $1`, [
          runId,
        ]),
      { timeout: 30_000 },
    )
    .toBe("Done");
});
