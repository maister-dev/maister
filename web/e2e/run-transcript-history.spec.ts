import type { Locator, Page, Request } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

type HistoryFixture = {
  agentRunId: string;
  flowRunId: string;
  nodeAttemptId: string;
};

let fixture: HistoryFixture;

test.beforeEach(async () => {
  fixture = {
    agentRunId: randomUUID(),
    flowRunId: randomUUID(),
    nodeAttemptId: randomUUID(),
  };
  const source = loadFixtures().byKey.m22.runId;

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,agent_workspace) SELECT $1,project_id,'agent','Running','v1','history','none' FROM runs WHERE id=$2",
      [fixture.agentRunId, source],
    );
    await pool.query(
      "INSERT INTO runs(id,project_id,task_id,flow_id,run_kind,status,flow_version,flow_revision,current_step_id) SELECT $1,project_id,task_id,flow_id,'flow','Running',flow_version,flow_revision,'implement' FROM runs WHERE id=$2",
      [fixture.flowRunId, source],
    );
    await pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status,started_at) VALUES($1,$2,'implement','ai_coding',1,'Running',now())",
      [fixture.nodeAttemptId, fixture.flowRunId],
    );
    await pool.query(
      "INSERT INTO run_messages(id,run_id,node_attempt_id,sequence,role,content,supervisor_event_id) VALUES($1,$2,NULL,1,'assistant','First agent history','1'),($3,$4,$5,1,'assistant','First node history','1')",
      [
        randomUUID(),
        fixture.agentRunId,
        randomUUID(),
        fixture.flowRunId,
        fixture.nodeAttemptId,
      ],
    );
  });
});

test.afterEach(async () => {
  await withE2EDb((pool) =>
    pool.query("DELETE FROM runs WHERE id=ANY($1::text[])", [
      [fixture.agentRunId, fixture.flowRunId],
    ]),
  );
});

function history(page: Page): Locator {
  return page
    .locator('[data-testid="run-shell"]:visible')
    .getByTestId("run-shell-main")
    .getByTestId("run-transcript-history");
}

async function observeRunChanges(page: Page, runId: string): Promise<void> {
  await page.addInitScript((id) => {
    const state = { changes: 0, ready: false };
    const NativeEventSource = window.EventSource;

    Object.assign(window, { transcriptRunChanges: state });
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (String(url).includes(`/api/runs/${id}/peek/stream`)) {
          this.addEventListener("message", (event: MessageEvent<string>) => {
            const frame = JSON.parse(event.data) as {
              type: string;
              runId?: string;
              kind?: string;
            };

            if (frame.type === "peek.ready") state.ready = true;
            if (
              frame.type === "run.changed" &&
              frame.runId === id &&
              frame.kind === "transcript"
            )
              state.changes++;
          });
        }
      }
    };
  }, runId);
}

for (const surface of ["agent", "node"] as const) {
  test(`${surface} history publishes a slow initial response during live updates without concurrent reloads`, async ({
    page,
  }) => {
    const runId = surface === "agent" ? fixture.agentRunId : fixture.flowRunId;
    const initial = `First ${surface} history`;
    const updated = `Updated ${surface} history`;
    let firstRelease: () => void = () => {};
    let refreshRelease: () => void = () => {};
    let firstCaptured: () => void = () => {};
    let refreshCaptured: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      firstRelease = resolve;
    });
    const refreshHeld = new Promise<void>((resolve) => {
      refreshRelease = resolve;
    });
    const firstReady = new Promise<void>((resolve) => {
      firstCaptured = resolve;
    });
    const refreshReady = new Promise<void>((resolve) => {
      refreshCaptured = resolve;
    });
    const initialRequests: Request[] = [];
    let initialReleased = false;

    await observeRunChanges(page, runId);
    await page.route(`**/api/runs/${runId}/transcript*`, async (route) => {
      const isInitial = !initialReleased;

      if (isInitial) initialRequests.push(route.request());
      const response = await route.fetch();

      if (isInitial) {
        firstCaptured();
        await firstHeld;
      } else {
        refreshCaptured();
        await refreshHeld;
      }
      await route.fulfill({ response });
    });
    try {
      await page.goto(`/runs/${runId}`);
      await firstReady;
      await expect(history(page).getByRole("status")).toContainText(/Loading/);
      await expect(history(page)).not.toContainText(
        "No conversation has been recorded.",
      );
      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = window as typeof window & {
              transcriptRunChanges: { ready: boolean };
            };

            return state.transcriptRunChanges.ready;
          }),
        )
        .toBe(true);
      await withE2EDb((pool) =>
        pool.query("UPDATE run_messages SET content=$1 WHERE run_id=$2", [
          updated,
          runId,
        ]),
      );
      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = window as typeof window & {
              transcriptRunChanges: { changes: number };
            };

            return state.transcriptRunChanges.changes;
          }),
        )
        .toBeGreaterThan(0);
      // Keep the first real response slower than the former 400 ms refresh debounce.
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      // Hydration may cancel an initial mount; only its surviving request owns the read.
      expect(
        initialRequests.filter((request) => request.failure() === null),
      ).toHaveLength(1);
      initialReleased = true;
      firstRelease();
      await expect(history(page)).toContainText(initial);
      await refreshReady;
      await expect(history(page)).toContainText(initial);
      refreshRelease();
      await expect(history(page)).toContainText(updated);
      await expect(history(page)).not.toContainText(initial);
    } finally {
      firstRelease();
      refreshRelease();
    }
  });
}

test("agent history distinguishes a failed load from empty history and retries", async ({
  page,
}) => {
  let fail = true;

  await page.route(
    `**/api/runs/${fixture.agentRunId}/transcript*`,
    async (route) => {
      if (fail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ reason: "transport" }),
        });

        return;
      }
      await route.continue();
    },
  );
  await page.goto(`/runs/${fixture.agentRunId}`);
  await expect(history(page)).toContainText("Run content could not be loaded.");
  await expect(history(page)).not.toContainText(
    "No conversation has been recorded.",
  );
  fail = false;
  await history(page)
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await expect(history(page)).toContainText("First agent history");
  await expect(history(page)).not.toContainText(
    "Run content could not be loaded.",
  );
});

test("main agent history loads bounded pages and retains the reading position", async ({
  page,
}) => {
  await withE2EDb(async (pool) => {
    await pool.query("DELETE FROM run_messages WHERE run_id=$1", [
      fixture.agentRunId,
    ]);
    await pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) SELECT gen_random_uuid()::text,$1,n,'assistant','Parent history ' || n::text,'2026-01-01T00:00:00.000123Z' FROM generate_series(1,650)n",
      [fixture.agentRunId],
    );
  });
  const requests: URL[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());

    if (url.pathname === `/api/runs/${fixture.agentRunId}/transcript`)
      requests.push(url);
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.agentRunId}`);
  await expect(history(page).getByText(/^Parent history \d+$/)).toHaveCount(
    100,
  );
  await expect(
    history(page).getByText("Parent history 650", { exact: true }),
  ).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => url.searchParams.get("limit") === "100")).toBe(
    true,
  );
  const reading = history(page).getByText("Parent history 551", {
    exact: true,
  });

  await reading.scrollIntoViewIfNeeded();
  const top = (await reading.boundingBox())!.y;

  await history(page)
    .getByRole("button", { name: "Load earlier messages" })
    .click();
  await expect(history(page).getByText(/^Parent history \d+$/)).toHaveCount(
    200,
  );
  await expect
    .poll(async () => Math.abs((await reading.boundingBox())!.y - top))
    .toBeLessThan(2);
  for (let count = 3; count <= 5; count++) {
    await history(page)
      .getByRole("button", { name: "Load earlier messages" })
      .click();
    await expect(history(page).getByText(/^Parent history \d+$/)).toHaveCount(
      count * 100,
    );
  }
  await history(page)
    .getByRole("button", { name: "Load earlier messages" })
    .click();
  await expect(history(page).getByText(/^Parent history \d+$/)).toHaveCount(
    500,
  );
  await expect(history(page)).toContainText(
    "Newer displayed pages were unloaded",
  );
  await history(page)
    .getByRole("button", { name: "Latest messages", exact: true })
    .click();
  await expect(history(page).getByText(/^Parent history \d+$/)).toHaveCount(
    100,
  );
  await expect(history(page)).toContainText("Parent history 650");
});
