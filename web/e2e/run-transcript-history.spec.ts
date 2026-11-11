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

async function scrollWithinDocument(
  message: Locator,
  viewportFraction: number,
): Promise<void> {
  await message.evaluate((element, fraction) => {
    const bounds = element.getBoundingClientRect();

    window.scrollBy(
      0,
      bounds.top - (window.innerHeight - bounds.height) * fraction,
    );
  }, viewportFraction);
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
      await page.unrouteAll({ behavior: "wait" });
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

test("main history loads the latest portion, retries an automatic earlier load and respects live reading position", async ({
  page,
}) => {
  await withE2EDb(async (pool) => {
    await pool.query("DELETE FROM run_messages WHERE run_id=$1", [
      fixture.agentRunId,
    ]);
    await pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) SELECT gen_random_uuid()::text,$1,n,'assistant','Parent history ' || n::text,'2026-01-01T00:00:00.000123Z' FROM generate_series(1,250)n",
      [fixture.agentRunId],
    );
  });
  const requests: URL[] = [];
  let failEarlier = true;
  const boundaries: string[] = [];
  let releaseFailure: () => void = () => {};
  let captureEarlier: () => void = () => {};
  const failureHeld = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const earlierRequested = new Promise<void>((resolve) => {
    captureEarlier = resolve;
  });

  await page.route(
    `**/api/runs/${fixture.agentRunId}/transcript?*`,
    async (route) => {
      const url = new URL(route.request().url());
      const before = url.searchParams.get("before");

      requests.push(url);
      if (before) {
        boundaries.push(before);
        if (failEarlier) {
          captureEarlier();
          await failureHeld;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ reason: "transport" }),
          });

          return;
        }
      }
      await route.continue();
    },
  );
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/runs/${fixture.agentRunId}`);
    const transcript = history(page);
    const messages = transcript.getByText(
      /^Parent history \d+(?: \(continued\))?$/,
    );
    const reading = transcript.getByText("Parent history 151", { exact: true });

    await expect(messages).toHaveCount(100);
    await expect(
      transcript.getByText("Parent history 250", { exact: true }),
    ).toBeInViewport();
    await expect(
      transcript.getByText("Parent history 150", { exact: true }),
    ).toHaveCount(0);
    expect(
      requests.every((url) => url.searchParams.get("limit") === "100"),
    ).toBe(true);
    await scrollWithinDocument(reading, 0);
    await expect
      .poll(async () => ({
        ...(await transcript.evaluate((element) => ({
          scrollTop: document.scrollingElement?.scrollTop,
          firstTop: element
            .querySelector("[data-transcript-message-id]")
            ?.getBoundingClientRect().top,
          tailTop: element
            .querySelector('[data-testid="transcript-tail"]')
            ?.getBoundingClientRect().top,
          viewportHeight: window.innerHeight,
        }))),
        earlierRequests: boundaries.length,
      }))
      .toMatchObject({ earlierRequests: 1 });
    await earlierRequested;
    await expect(
      transcript.getByTestId("transcript-history-loading"),
    ).toContainText("Loading earlier messages");
    await expect(
      transcript.getByRole("button", { name: "Load earlier messages" }),
    ).toBeDisabled();
    await transcript
      .getByRole("button", { name: "Load earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    expect(boundaries).toHaveLength(1);
    releaseFailure();
    await expect(
      transcript.getByRole("button", { name: "Retry earlier messages" }),
    ).toBeVisible();
    await expect(messages).toHaveCount(100);
    expect(boundaries).toHaveLength(1);
    await page.evaluate(async () => {
      window.scrollBy(0, 10);
      window.scrollBy(0, -10);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(boundaries).toHaveLength(1);
    const top = (await reading.boundingBox())!.y;

    failEarlier = false;
    await transcript
      .getByRole("button", { name: "Retry earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(messages).toHaveCount(200);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toBe(boundaries[1]);
    await expect
      .poll(async () => Math.abs((await reading.boundingBox())!.y - top))
      .toBeLessThan(2);
    // Activate the top button without moving the reading anchor to it first.
    await transcript
      .getByRole("button", { name: "Load earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(messages).toHaveCount(250);
    await expect(
      transcript.getByRole("button", { name: "Load earlier messages" }),
    ).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await reading.boundingBox())!.y - top))
      .toBeLessThan(2);
    const displayed = await messages.allTextContents();

    expect(displayed).toEqual(
      Array.from({ length: 250 }, (_, index) => `Parent history ${index + 1}`),
    );
    const jump = transcript.getByRole("button", { name: "Jump to latest" });

    await expect(jump).not.toHaveAttribute("data-new-messages", "true");
    await withE2EDb((pool) =>
      pool.query(
        "UPDATE run_messages SET content='Parent history 250 (continued)' WHERE run_id=$1 AND sequence=250",
        [fixture.agentRunId],
      ),
    );
    await expect(transcript).toContainText("Newer messages are available");
    await expect(
      transcript.getByTestId("transcript-jump-latest"),
    ).toHaveAttribute("data-new-messages", "true");
    await expect
      .poll(async () => Math.abs((await reading.boundingBox())!.y - top))
      .toBeLessThan(2);
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,251,'assistant','Parent history 251','2026-01-01T00:00:00.000123Z')",
        [randomUUID(), fixture.agentRunId],
      ),
    );
    await expect(transcript).toContainText("Newer messages are available");
    await expect(
      transcript.getByText("Parent history 251", { exact: true }),
    ).toHaveCount(1);
    await expect
      .poll(async () => Math.abs((await reading.boundingBox())!.y - top))
      .toBeLessThan(2);
    await page.getByTestId("librarian-trigger").click();
    await expect(page.getByTestId("librarian-panel")).toHaveAttribute(
      "data-mode",
      "docked",
    );
    const jumpIsContained = (): Promise<boolean> =>
      jump.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const owner = button
          .closest('[data-testid="run-transcript-history"]')!
          .getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );

        return (
          bounds.left >= owner.left &&
          bounds.right <= owner.right &&
          bounds.top >= owner.top &&
          bounds.bottom <= owner.bottom &&
          button.contains(hit)
        );
      });

    await expect.poll(jumpIsContained).toBe(true);
    const shortHeight = await transcript.evaluate((element) =>
      Math.min(
        window.innerHeight,
        Math.ceil(element.getBoundingClientRect().top + window.scrollY + 60),
      ),
    );

    await page.setViewportSize({ width: 1600, height: shortHeight });
    await transcript.evaluate((element) =>
      window.scrollBy(
        0,
        element.getBoundingClientRect().top - window.innerHeight + 60,
      ),
    );
    await expect
      .poll(() =>
        transcript.evaluate((element) =>
          Math.abs(
            window.innerHeight - element.getBoundingClientRect().top - 60,
          ),
        ),
      )
      .toBeLessThan(2);
    await expect.poll(jumpIsContained).toBe(true);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await jump.click();
    await page.getByTestId("librarian-close").click();
    await expect(messages).toHaveCount(100);
    await expect(
      transcript.getByText("Parent history 251", { exact: true }),
    ).toBeInViewport();
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,252,'assistant','Parent history 252','2026-01-01T00:00:00.000123Z')",
        [randomUUID(), fixture.agentRunId],
      ),
    );
    await expect(
      transcript.getByText("Parent history 252", { exact: true }),
    ).toBeInViewport();
    await expect(
      transcript.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toHaveCount(0);
    const middle = transcript.getByText("Parent history 200", { exact: true });

    await scrollWithinDocument(middle, 0.5);
    await expect(
      transcript.getByTestId("transcript-jump-latest"),
    ).toBeVisible();
    const middleTop = (await middle.boundingBox())!.y;

    await withE2EDb((pool) =>
      pool.query(
        "UPDATE run_messages SET content='Parent history 252 (continued)' WHERE run_id=$1 AND sequence=252",
        [fixture.agentRunId],
      ),
    );
    await expect(transcript).toContainText("Newer messages are available");
    await expect
      .poll(async () => Math.abs((await middle.boundingBox())!.y - middleTop))
      .toBeLessThan(2);
    await scrollWithinDocument(
      transcript.getByText("Parent history 252 (continued)", { exact: true }),
      1,
    );
    await expect(
      transcript.getByText(/Newer messages are available/),
    ).toHaveCount(0);
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) SELECT gen_random_uuid()::text,$1,n,'assistant','Parent history ' || n::text,'2026-01-01T00:00:00.000123Z' FROM generate_series(253,453)n",
        [fixture.agentRunId],
      ),
    );
    await expect(
      transcript.getByText("Parent history 453", { exact: true }),
    ).toBeInViewport();
    const anchors = transcript.locator("[data-transcript-message-id]");
    const uniqueIds = async (): Promise<string[]> =>
      anchors.evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute("data-transcript-message-id")!,
        ),
      );
    const afterBurst = await uniqueIds();

    expect(afterBurst.length).toBe(new Set(afterBurst).size);
    expect(afterBurst.length).toBeLessThanOrEqual(500);
    await scrollWithinDocument(
      transcript.getByText("Parent history 152", { exact: true }),
      0,
    );
    await expect(
      transcript.getByText("Parent history 151", { exact: true }),
    ).toHaveCount(1);
    const afterEarlier = await uniqueIds();

    expect(afterEarlier.length).toBe(new Set(afterEarlier).size);
    expect(afterEarlier.length).toBeLessThanOrEqual(500);
    await transcript
      .getByRole("button", { name: "Jump to latest", exact: true })
      .click();
    await expect(
      transcript.getByText("Parent history 453", { exact: true }),
    ).toBeInViewport();
  } finally {
    releaseFailure();
  }
});

for (const surface of ["agent", "node"] as const) {
  test(`${surface} transcript renders a large complete tool and its following message without empty preview cards`, async ({
    page,
  }) => {
    const runId = surface === "agent" ? fixture.agentRunId : fixture.flowRunId;
    const attemptId = surface === "agent" ? null : fixture.nodeAttemptId;
    const tool = {
      v: 1,
      kind: "tool",
      name: "Read",
      toolKind: "read",
      status: "completed",
      arg: "src/large.ts",
      rawInput: { file_path: "src/large.ts" },
      result: '界\n"'.repeat(30_000),
    };

    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM run_messages WHERE run_id=$1", [runId]);
      await pool.query(
        "INSERT INTO run_messages(id,run_id,node_attempt_id,sequence,role,content,created_at,supervisor_event_id) SELECT gen_random_uuid()::text,$1,$2,n,'assistant','Mixed history ' || n::text,'2026-01-01T00:00:00.000123Z',n::text FROM generate_series(1,105)n",
        [runId, attemptId],
      );
      await pool.query(
        "UPDATE run_messages SET role='tool',content=$1 WHERE run_id=$2 AND sequence=104",
        [JSON.stringify(tool), runId],
      );
      for (const [sequence, label] of [
        [5, "first"],
        [6, "second"],
      ] as const) {
        await pool.query(
          "UPDATE run_messages SET role='tool',content=$1 WHERE run_id=$2 AND sequence=$3",
          [
            JSON.stringify({
              ...tool,
              name: "Bash",
              toolKind: "execute",
              arg: `${label} command`,
              rawInput: { command: `echo ${label}` },
              result: `${label} boundary result`,
            }),
            runId,
            sequence,
          ],
        );
      }
      await pool.query(
        "UPDATE run_messages SET role='user',content='Mixed user prompt' WHERE run_id=$1 AND sequence=101",
        [runId],
      );
      await pool.query(
        "UPDATE run_messages SET role='system',content=$1 WHERE run_id=$2 AND sequence=102",
        [JSON.stringify({ v: 1, kind: "usage", used: 123, size: 456 }), runId],
      );
      await pool.query(
        "UPDATE run_messages SET role='system',content=$1 WHERE run_id=$2 AND sequence=103",
        [
          JSON.stringify({
            v: 1,
            kind: "thought",
            text: "Inspect the large file carefully",
          }),
          runId,
        ],
      );
    });
    await page.goto(`/runs/${runId}`);
    const transcript = history(page);

    await expect(
      transcript.getByText("Mixed history 105", { exact: true }),
    ).toBeInViewport();
    await expect(transcript.getByTestId("peek-bounded-preview")).toHaveCount(0);
    await expect(
      transcript.getByText("Mixed user prompt", { exact: true }),
    ).toHaveCount(1);
    await expect(transcript).toContainText("123 / 456");
    await transcript
      .getByRole("button", { name: /Thinking/ })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(transcript).toContainText("Inspect the large file carefully");
    await expect(
      transcript.getByRole("button", { name: /Read.*src\/large.ts/ }),
    ).toHaveCount(1);
    await transcript
      .getByRole("button", { name: /Read.*src\/large.ts/ })
      .click();
    await expect(transcript).toContainText(tool.result.slice(0, 40));
    await expect(transcript).not.toContainText('"rawInput"');
    await transcript
      .getByRole("button", { name: "Load earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(
      transcript.getByText("Mixed history 1", { exact: true }),
    ).toHaveCount(1);
    await transcript
      .getByRole("button", { name: /Bash ×2/ })
      .evaluate((element: HTMLButtonElement) => element.click());
    for (const label of ["first", "second"]) {
      await transcript
        .getByRole("button", { name: new RegExp(`Bash.*${label} command`) })
        .evaluate((element: HTMLButtonElement) => element.click());
      await expect(transcript).toContainText(`${label} boundary result`);
    }
    await expect(
      transcript.getByRole("button", { name: /Read.*src\/large.ts/ }),
    ).toHaveCount(1);
  });
}

test("a newer visible-window response wins over the older latest snapshot in the same refresh", async ({
  page,
}) => {
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,2,'assistant','Existing window tail')",
      [randomUUID(), fixture.agentRunId],
    ),
  );
  await page.goto(`/runs/${fixture.agentRunId}`);
  await expect(history(page)).toContainText("First agent history");
  let injected = false;
  let afterRequests = 0;
  let releaseFollowing: () => void = () => {};
  const followingHeld = new Promise<void>((resolve) => {
    releaseFollowing = resolve;
  });

  await page.route(
    `**/api/runs/${fixture.agentRunId}/transcript?*`,
    async (route) => {
      const query = new URL(route.request().url()).searchParams;

      if ((query.has("windowBefore") || query.has("anchor")) && !injected) {
        injected = true;
        await withE2EDb(async (pool) => {
          await pool.query(
            "UPDATE run_messages SET content='Newest visible content' WHERE run_id=$1 AND sequence=1",
            [fixture.agentRunId],
          );
          await pool.query(
            "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,3,'assistant','Inserted during visible refresh')",
            [randomUUID(), fixture.agentRunId],
          );
        });
        const response = await route.fetch();

        await route.fulfill({ response });

        return;
      }
      if (query.has("after")) afterRequests++;
      if (injected && !query.has("windowBefore") && !query.has("anchor"))
        await followingHeld;
      await route.continue();
    },
  );
  try {
    await withE2EDb((pool) =>
      pool.query(
        "UPDATE run_messages SET content='Older latest snapshot' WHERE run_id=$1 AND sequence=1",
        [fixture.agentRunId],
      ),
    );
    await expect(history(page)).toContainText("Newest visible content");
    expect(injected).toBe(true);
    await expect(history(page)).not.toContainText("Older latest snapshot");
    await expect(
      history(page).getByText("Inserted during visible refresh", {
        exact: true,
      }),
    ).toHaveCount(1);
    const anchors = await history(page)
      .locator("[data-transcript-message-id]")
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.getAttribute("data-transcript-message-id"),
        ),
      );

    expect(anchors).toHaveLength(3);
    expect(new Set(anchors).size).toBe(3);
    expect(afterRequests).toBe(0);
  } finally {
    releaseFollowing();
    await page.unrouteAll({ behavior: "wait" });
  }
});
