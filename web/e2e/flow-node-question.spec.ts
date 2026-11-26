import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { startCheckoutReference } from "../../mcp/test/fixtures/checkout-reference";

import { singleValue } from "./_seed/db";
import {
  assertActive,
  createFixture,
  launch,
} from "./_seed/studio-catalog-run";

type BrowserRunEvent = { type: string; eventId: string };

test("E2E-ASK-03 races one human assignment across Inbox and Run and replays its delivery receipts", async ({
  browser,
  context,
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(330_000);
  const reference = await startCheckoutReference();
  const detail = await context.newPage();
  const anonymous = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });

  try {
    const fx = await createFixture(info.outputDir, reference.url);
    const origin = new URL(baseURL!).origin;
    const runId = await launch(request, origin, {
      ...fx.members.design,
      runnerId: fx.project.runnerId,
    });
    const openQuestion = async () => {
      await assertActive(runId);

      return singleValue<{ id: string; prompt: string }>(
        `SELECT json_build_object('id',q.id,'prompt',q.prompt) AS value
        FROM hitl_requests q JOIN assignments a ON a.hitl_request_id=q.id AND a.run_id=q.run_id
        WHERE q.run_id=$1 AND q.flow_node_attempt_id IS NOT NULL AND q.activation_state='active' AND a.status='open'`,
        [runId],
      );
    };

    await expect.poll(openQuestion, { timeout: 120_000 }).toBeTruthy();
    const question = (await openQuestion())!;
    const path = `/api/runs/${runId}/hitl/${question.id}/respond`;

    await Promise.all([page.goto("/inbox"), detail.goto(`/runs/${runId}`)]);
    const inboxCard = page
      .getByTestId("hitl-card")
      .filter({ has: page.getByText(fx.designTaskTitle, { exact: true }) })
      .filter({ hasText: question.prompt })
      .filter({ visible: true });
    const runCard = detail
      .getByTestId("pending-input-card")
      .filter({ hasText: question.prompt });

    await expect(inboxCard).toHaveCount(1);
    await expect(runCard).toHaveCount(1);
    await inboxCard.locator("button[aria-expanded]").first().click();
    const inboxForm = inboxCard.getByTestId("agent-question-response");
    const runForm = runCard.getByTestId("agent-question-response");
    const field = { name: /Journey/ };
    const answer = [
      "Guest checkout " + randomUUID(),
      "Guest checkout " + randomUUID(),
    ];

    await Promise.all([
      inboxForm.getByRole("textbox", field).fill(answer[0]),
      runForm.getByRole("textbox", field).fill(answer[1]),
    ]);
    const denied = await anonymous.request.post(path, {
      data: { response: { journey: answer[0] } },
      headers: { Origin: origin },
    });

    expect([401, 403]).toContain(denied.status());

    // Both normal forms have prepared their different answers before either request reaches Web.
    // Resume work on the production supervisor can proceed immediately after the first commit.
    const sent = Promise.withResolvers<void>();
    let waiting = 0;

    await context.route("**" + path, async (route) => {
      if (route.request().method() === "POST") {
        if (++waiting === 2) sent.resolve();
        await sent.promise;
      }
      await route.continue();
    });
    const [left, right] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(path) &&
          response.request().method() === "POST",
      ),
      detail.waitForResponse(
        (response) =>
          response.url().endsWith(path) &&
          response.request().method() === "POST",
      ),
      inboxForm.getByRole("button", { name: "Answer clarification" }).click(),
      runForm.getByRole("button", { name: "Answer clarification" }).click(),
    ]);

    expect([left.status(), right.status()].sort()).toEqual([202, 409]);
    const accepted = left.status() === 202 ? left : right;

    expect(await accepted.json()).toMatchObject({
      ok: true,
      runStatus: expect.any(String),
      questionId: question.id,
      state: "accepted",
    });
    const winningAnswer = answer[left.status() === 202 ? 0 : 1];

    // Reconnect to the normal browser stream and replay the immutable manager events by sequence.
    const events = await detail.evaluate(
      async ({ runId, receipts }) => {
        const stream = new EventSource(
          "/api/runs/" + runId + "/stream?replay=true",
        );
        const observed: BrowserRunEvent[] = [];

        return await new Promise<BrowserRunEvent[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            stream.close();
            reject(
              new Error(
                "Answer delivery stream did not reach both decision receipts",
              ),
            );
          }, 120_000);

          stream.onmessage = ({ data }) => {
            const event = JSON.parse(data) as BrowserRunEvent;

            if (
              event.type !== "hitl.responded" ||
              !event.eventId ||
              observed.some((item) => item.eventId === event.eventId)
            )
              return;
            observed.push(event);
            if (observed.length === receipts) {
              clearTimeout(timer);
              stream.close();
              resolve(observed);
            }
          };
        });
      },
      { runId, receipts: 2 },
    );
    const receipts = await singleValue<{ id: string; state: string }[]>(
      `SELECT json_agg(json_build_object('id',id,'state',split_part(source_key,':',3)) ORDER BY run_sequence) AS value
      FROM execution_events WHERE run_id=$1 AND source_key IN ($2,$3)`,
      [
        runId,
        `flow-node-question:${question.id}:accepted`,
        `flow-node-question:${question.id}:delivered`,
      ],
    );

    expect(receipts?.map((item) => item.state)).toEqual([
      "accepted",
      "delivered",
    ]);
    expect(events.map((item) => item.eventId)).toEqual(
      receipts?.map((item) => item.id),
    );
    const replay = await request.post(path, {
      headers: { Origin: origin },
      data: { response: { journey: winningAnswer } },
    });

    expect(replay.status(), await replay.text()).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      runStatus: expect.any(String),
      questionId: question.id,
      state: "delivered",
    });
    await expect(runCard).toHaveCount(0, { timeout: 30_000 });
    await expect(inboxCard).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await anonymous.close();
    await detail.close();
    await reference.close();
  }
});
