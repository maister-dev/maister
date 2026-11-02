// M34 (ADR-089) e2e (a): manual catalog launch from the task detail page.
// "Run agent" POSTs /api/projects/{slug}/agents/{id}/launch → an agent-kind
// run spins up against the stub supervisor (a real /sessions round-trip:
// createSession → prompt → SSE), the project page shows the run in the active
// grid with the agent + trigger chip, and after the spec releases the held
// stub stream the run finalizes Done at the terminal choke point.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { withE2EDb, singleValue } from "./_seed/db";
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
  await expect(
    page.locator(`[data-agent-run-id="${runId}"]`).filter({ visible: true }),
  ).toHaveCount(2);

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

test("E2E-SR-01 create, edit, clear and execute independent scheduled requests (EN/RU)", async ({
  page,
  context,
  baseURL,
  browser,
}) => {
  test.setTimeout(180_000);
  const fx = loadFixtures().byKey.platformAgents;
  const endpoint = `/api/projects/${fx.projectSlug}/agents/${fx.helperAgentId}`;
  const detailUrl = `/projects/${fx.projectSlug}/agents/${encodeURIComponent(fx.helperAgentId)}`;
  const sourcePath = await singleValue<string>(
    "SELECT source_path AS value FROM agents WHERE id=$1",
    [fx.helperAgentId],
  );

  if (!sourcePath) throw new Error("Missing pinned agent definition fixture");
  const definition = readFileSync(sourcePath, "utf8");

  writeFileSync(
    sourcePath,
    definition.replace("  - manual", "  - manual\n  - cron"),
  );
  await withE2EDb((pool) =>
    pool.query(
      'UPDATE agents SET triggers=\'["manual","flow","cron"]\'::jsonb WHERE id=$1',
      [fx.helperAgentId],
    ),
  );
  const requestA = "Scheduled browser request A\nПроверить {{ literal }} 😀";
  const requestB = "Independent browser request B";
  const open = async (): Promise<void> => {
    await page.goto(`${detailUrl}?tab=settings`);
    await page
      .getByRole("button", { name: /^(Edit|Изменить|Редактировать)$/ })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
  };
  const save = async (): Promise<void> => {
    const response = page.waitForResponse(
      (value) =>
        value.url().endsWith(endpoint) && value.request().method() === "PATCH",
    );

    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^(Save|Сохранить)$/ })
      .click();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };

  try {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await open();
    await page.getByRole("button", { name: "+ cron", exact: true }).click();
    await page.getByRole("button", { name: "+ cron", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Cron expression", exact: true })
      .nth(1)
      .fill("0 9 * * *");
    const fieldA = page
      .locator("article")
      .filter({ has: page.locator('input[value="*/30 * * * *"]') })
      .getByRole("textbox", {
        name: /^(Request at launch|Запрос при запуске)$/,
      });
    const fieldB = page
      .locator("article")
      .filter({ has: page.locator('input[value="0 9 * * *"]') })
      .getByRole("textbox", {
        name: /^(Request at launch|Запрос при запуске)$/,
      });
    const fields = page.getByRole("textbox", {
      name: "Request at launch",
      exact: true,
    });

    await expect(fields).toHaveCount(2);
    await fieldA.fill("😀".repeat(8001));
    await expect(fieldA).toHaveAttribute("aria-invalid", "true");
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await fieldA.fill(requestA);
    await fieldB.fill(requestB);
    await save();
    await open();
    await expect(fieldA).toHaveValue(requestA);
    await expect(fieldB).toHaveValue(requestB);
    await fieldA.fill(" \n\t");
    await save();
    const state = await (
      await page.request.get(`/api/projects/${fx.projectSlug}/agents`)
    ).json();
    const cleared = state.attached.find(
      (row: { agent: { id: string } }) => row.agent.id === fx.helperAgentId,
    ).schedules;

    expect(
      cleared.map(
        (row: { requestAtLaunch: string | null }) => row.requestAtLaunch,
      ),
    ).toEqual(expect.arrayContaining([null, requestB]));
    await open();
    await fieldA.fill(requestA);
    await save();
    const scheduleId = cleared.find(
      (row: { cronExpr: string }) => row.cronExpr === "*/30 * * * *",
    ).id;

    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE agent_schedules SET next_fire_at=now()-interval '1 minute' WHERE id=$1",
        [scheduleId],
      );
      await pool.query(
        "UPDATE scheduler_jobs SET next_run_at=now()-interval '1 minute',disabled_at=NULL WHERE id='agent_tick.dispatcher'",
      );
    });
    const tick = await page.request.post("/api/cron/tick?jobKind=agent_tick", {
      headers: {
        Authorization: `Bearer ${process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me"}`,
      },
    });

    expect(tick.ok()).toBe(true);
    const runId = await singleValue<string>(
      "SELECT last_run_id AS value FROM agent_schedules WHERE id=$1",
      [scheduleId],
    );

    if (!runId) throw new Error("The cron invocation has no launch receipt");
    const session = await waitForSession(
      (record) =>
        record.request.runId === runId &&
        record.prompts.some((prompt) => prompt.prompt.includes(requestA)),
    );

    expect(session.prompts[0].prompt.split(requestA)).toHaveLength(2);
    await open();
    await fieldA.fill("Changed after claim");
    await save();
    for (const locale of ["en", "ru"] as const) {
      await context.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      ]);
      await page.goto(`${detailUrl}?tab=history`);
      const row = page.locator(`[data-agent-history-run-id="${runId}"]`);

      await row
        .locator("summary")
        .filter({
          hasText:
            locale === "en" ? "Scheduled request" : "Запрос по расписанию",
        })
        .click();
      await expect(row).toContainText(requestA);
      await expect(row).not.toContainText("Changed after claim");
      await open();
      await expect(fieldA).toHaveValue("Changed after claim");
    }
    releaseSession(session.sessionId);
    await expect
      .poll(
        () =>
          singleValue<string>("SELECT status AS value FROM runs WHERE id=$1", [
            runId,
          ]),
        { timeout: 30_000 },
      )
      .toBe("Done");
    const viewer = loadFixtures().users.memberCandidate;

    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'viewer')",
        [crypto.randomUUID(), fx.projectId, viewer.id],
      ),
    );
    const viewerContext = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });

    try {
      const viewerPage = await viewerContext.newPage();

      await viewerPage.goto("/login");
      await viewerPage.locator('input[name="email"]').fill(viewer.email);
      await viewerPage.locator('input[name="password"]').fill(viewer.password);
      await viewerPage.locator('form button[type="submit"]').click();
      await viewerPage.waitForURL((url) => !url.pathname.startsWith("/login"));
      const hidden = await viewerPage.request.get(`${detailUrl}?tab=history`);

      expect(await hidden.text()).not.toContain("Scheduled browser request A");
      const settingsUrl = `/projects/${fx.projectSlug}?tab=agents`;
      const hiddenSettings = await viewerPage.request.get(settingsUrl);

      expect(hiddenSettings.status()).toBe(200);
      expect(await hiddenSettings.text()).not.toContain(requestB);
      expect(
        await (await viewerPage.request.get(`/runs/${runId}`)).text(),
      ).not.toContain("Scheduled browser request A");
      const streamText = await viewerPage.evaluate(async (id) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        let text = "";

        try {
          const response = await fetch(`/api/runs/${id}/stream?replay=true`, {
            signal: controller.signal,
          });

          if (!response.ok || !response.body)
            throw new Error(`Stream refused: ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();

          for (;;) {
            const chunk = await reader.read();

            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "AbortError"))
            throw error;
        } finally {
          clearTimeout(timer);
        }

        return text;
      }, runId);

      expect(streamText).not.toContain("Scheduled browser request A");
      await withE2EDb((pool) =>
        pool.query(
          "UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2",
          [fx.projectId, viewer.id],
        ),
      );
      expect(
        await (await viewerPage.request.get(`${detailUrl}?tab=history`)).text(),
      ).toContain("Scheduled browser request A");
      expect(
        await (await viewerPage.request.get(settingsUrl)).text(),
      ).toContain(requestB);
      await withE2EDb((pool) =>
        pool.query(
          "UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",
          [fx.projectId, viewer.id],
        ),
      );
      expect(
        await (await viewerPage.request.get(`${detailUrl}?tab=history`)).text(),
      ).not.toContain("Scheduled browser request A");
      expect(
        await (await viewerPage.request.get(settingsUrl)).text(),
      ).not.toContain(requestB);
    } finally {
      await viewerContext.close();
      await withE2EDb((pool) =>
        pool.query(
          "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
          [fx.projectId, viewer.id],
        ),
      );
    }
  } finally {
    writeFileSync(sourcePath, definition);
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM agent_schedules WHERE agent_id=$1", [
        fx.helperAgentId,
      ]);
      await pool.query(
        'UPDATE agents SET triggers=\'["manual","flow"]\'::jsonb WHERE id=$1',
        [fx.helperAgentId],
      );
    });
  }
});
