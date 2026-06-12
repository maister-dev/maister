// M34 (ADR-090 L3) e2e (c): the dirty-watchdog quarantine. A repo_read agent
// launches against a clean parent checkout; the spec dirties the repo while
// the stub supervisor HOLDS the session stream, then releases it. The
// terminal choke point's watchdog attributes the dirt, quarantines the agent
// in ONE transaction (flag + system comment on the bound task), and every
// relaunch is refused with PRECONDITION until an admin un-quarantines.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { STUB_SESSIONS_DIR } from "./_seed/stub-supervisor";

type SessionRecord = {
  sessionId: string;
  request: { runId?: string };
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

test("repo_read dirt quarantines the agent, comments the task, and refuses relaunch", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.platformAgents;
  const q = fx.quarantine;

  await page.goto(`/projects/${q.projectSlug}/tasks/${q.taskNumber}`);
  await page
    .getByRole("combobox", { name: "Agent to run" })
    .selectOption(fx.auditorAgentId);

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/agents/${fx.auditorAgentId}/launch`) &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Run agent" }).click();

  const response = await launchResponse;

  expect(response.status()).toBe(202);

  const { runId } = (await response.json()) as { runId: string };
  const session = await waitForSession(
    (record) => record.request.runId === runId,
  );

  // The held stream is the injection window: dirty the parent checkout the
  // repo_read run is pointed at, then let the session exit.
  writeFileSync(
    path.join(q.repoPath, "ROGUE_WRITE.txt"),
    "the read-only contract was violated\n",
    "utf8",
  );
  writeFileSync(
    path.join(STUB_SESSIONS_DIR, `${session.sessionId}.release`),
    "go",
    "utf8",
  );

  // The terminal choke point ran the watchdog inside the status-flip tx.
  await expect
    .poll(
      () =>
        singleValue<string>(
          `SELECT quarantine_reason AS value FROM agents WHERE id = $1`,
          [fx.auditorAgentId],
        ),
      { timeout: 30_000 },
    )
    .toContain("ROGUE_WRITE.txt");

  // The system comment landed on the bound task's timeline. (The agent id is
  // a markdown code span, so assert on a substring that stays inside one
  // text node of the rendered paragraph.)
  await page.goto(`/projects/${q.projectSlug}/tasks/${q.taskNumber}`);
  await expect(page.getByText("was quarantined after run")).toBeVisible();

  // The picker itself hides quarantined agents, so assert the server
  // contract directly: every relaunch entry point refuses with PRECONDITION
  // until an admin un-quarantines.
  const refused = await page.request.post(
    `/api/projects/${q.projectSlug}/agents/${fx.auditorAgentId}/launch`,
    { data: { taskId: q.taskId } },
  );

  expect(refused.status()).toBe(409);

  const body = (await refused.json()) as { code: string; message: string };

  expect(body.code).toBe("PRECONDITION");
  expect(body.message).toContain("quarantined");
});
