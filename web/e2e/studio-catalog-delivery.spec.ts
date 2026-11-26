import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { startCheckoutReference } from "../../mcp/test/fixtures/checkout-reference";

import { singleValue } from "./_seed/db";
import {
  assertActive,
  createFixture,
  launch,
} from "./_seed/studio-catalog-run";

async function artifact(runId: string, name: string): Promise<string> {
  await assertActive(runId);
  const path = await singleValue<string>(
    "SELECT worktree_path AS value FROM workspaces WHERE run_id=$1",
    [runId],
  );

  if (!path) return "";
  try {
    return await readFile(join(path, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

let reference: Awaited<ReturnType<typeof startCheckoutReference>>;

test.beforeAll(async () => {
  reference = await startCheckoutReference();
});
test.afterAll(async () => {
  await reference?.close();
});

test("E2E-CAP-06 delivers a designer's human answer and keeps its MCP out of a coding Run", async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.setTimeout(420_000);
  const fx = await createFixture(testInfo.outputDir, reference.url);
  const origin = new URL(baseURL!).origin;
  const design = await launch(request, origin, {
    ...fx.members.design,
    runnerId: fx.project.runnerId,
  });
  const coding = await launch(request, origin, {
    ...fx.members.coding,
    runnerId: fx.project.runnerId,
  });
  const activeQuestion = async (): Promise<string | null> => {
    await assertActive(design);

    return singleValue(
      `SELECT id AS value FROM hitl_requests WHERE run_id=$1 AND kind='agent_question'
       AND flow_node_attempt_id IS NOT NULL AND activation_state='active' AND superseded_at IS NULL AND responded_at IS NULL`,
      [design],
    );
  };

  await expect.poll(activeQuestion, { timeout: 120_000 }).toBeTruthy();
  const questionId = await activeQuestion();
  const answer = `Guest checkout ${randomUUID()}`;

  await page.goto("/inbox");
  const card = page
    .getByTestId("hitl-card")
    .filter({ has: page.getByText(fx.designTaskTitle, { exact: true }) })
    .filter({ hasText: "Which checkout journey should the prototype cover?" })
    .filter({ visible: true });

  await expect(card).toHaveCount(1);
  await card.locator("button[aria-expanded]").first().click();
  const form = card.getByTestId("agent-question-response");

  await form.getByRole("textbox", { name: /Journey/ }).fill(answer);
  const delivery = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/hitl/" + questionId + "/respond"),
  );

  await form.getByRole("button", { name: "Answer clarification" }).click();
  const response = await delivery;

  expect([200, 202], await response.text()).toContain(response.status());
  await expect
    .poll(() => artifact(design, "prototype.html"), { timeout: 150_000 })
    .toContain(fx.designMarker);
  const prototype = await artifact(design, "prototype.html");

  expect(prototype).toContain(answer);
  expect(reference.calls()).toBeGreaterThan(0);
  expect(prototype).toContain(reference.receipt);
  // Parse the artifact as inert HTML; its own scripts are outside this acceptance check.
  const clickable = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, "text/html");

    return Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href^='#']"),
    ).some(
      (link) =>
        !!link.textContent?.trim() &&
        !!document.getElementById(link.hash.slice(1)),
    );
  }, prototype);

  expect(clickable).toBe(true);
  await expect
    .poll(() => artifact(coding, "verification.txt"), { timeout: 120_000 })
    .toContain(fx.devMarker);
  expect(await artifact(coding, "verification.txt")).toContain(fx.coreMarker);
  const inventory = (id: string): Promise<string[] | null> =>
    singleValue(
      `SELECT COALESCE(jsonb_agg(entry->>'refId') FILTER (WHERE entry->>'kind'='mcp'), '[]') AS value
       FROM node_attempts n LEFT JOIN LATERAL jsonb_array_elements(n.materialization_plan->'resolvedRevisions') entry ON true
       WHERE n.run_id=$1 AND n.node_id='work' AND n.materialization_plan ? 'resolvedRevisions'
       GROUP BY n.id ORDER BY n.attempt DESC LIMIT 1`,
      [id],
    );

  expect(await inventory(design)).toContain(fx.mcp);
  const codingInventory = await inventory(coding);

  expect(codingInventory).toEqual(expect.any(Array));
  expect(codingInventory).not.toContain(fx.mcp);
  const readDeliveryProof = () =>
    singleValue(
      `SELECT json_build_object('attemptId',h.flow_node_attempt_id,'deliveredAt',h.responded_at,
         'hostId',s.execution_host_id,'acpId',s.acp_session_id) AS value
         FROM hitl_requests h JOIN run_session_incarnations s
         ON s.run_id=h.run_id AND s.id=h.schema->'flowQuestion'->>'incarnationId'
         WHERE h.id=$1 AND s.acp_session_id IS NOT NULL`,
      [questionId],
    );

  await expect.poll(readDeliveryProof, { timeout: 30_000 }).toMatchObject({
    attemptId: expect.any(String),
    deliveredAt: expect.any(String),
    hostId: expect.any(String),
    acpId: expect.any(String),
  });
  const proof = await readDeliveryProof();
  const agentApi =
    "/api/projects/" +
    fx.project.projectSlug +
    "/agents/" +
    encodeURIComponent(fx.agent);
  const scopeApi =
    "/api/projects/" +
    fx.project.projectSlug +
    "/packages/" +
    fx.attachments.dev.id +
    "/mcps/" +
    fx.addition +
    "/scope";
  const packageScope = await singleValue<number>(
    "SELECT scope_revision AS value FROM project_package_attachments WHERE id=$1",
    [fx.attachments.dev.id],
  );
  const override = await request.put(scopeApi, {
    headers: { Origin: origin },
    data: {
      scope: "project",
      expectedInstallId: fx.attachments.dev.installId,
      expectedRevision: packageScope,
    },
  });

  expect(override.ok(), await override.text()).toBe(true);
  const shared = await override.json();

  expect(shared).toMatchObject({
    declared: "package",
    effective: "project",
    origin: "override",
  });
  const sharedAgent = await request.get(agentApi + "/definition");

  expect((await sharedAgent.json()).instance.inheritedMcpRefs).toContain(
    fx.addition,
  );
  const reset = await request.put(scopeApi, {
    headers: { Origin: origin },
    data: {
      scope: null,
      expectedInstallId: fx.attachments.dev.installId,
      expectedRevision: shared.revision,
    },
  });

  expect(reset.ok(), await reset.text()).toBe(true);
  const inherited = await reset.json();

  expect(inherited).toMatchObject({
    declared: "package",
    effective: "package",
    origin: "package",
  });
  const agentView = await request.get(agentApi + "/definition");

  expect(agentView.ok(), await agentView.text()).toBe(true);
  const { instance } = await agentView.json();

  expect(instance.connectedMcpRefs).toContain(fx.addition);
  expect(instance.inheritedMcpRefs).not.toContain(fx.addition);
  const addition = await request.patch(agentApi, {
    headers: { Origin: origin },
    data: {
      additionalMcpRefs: [fx.addition],
      expectedInstallId: instance.expectedInstallId,
      schedulesRevision: instance.revision,
    },
  });

  expect(addition.ok(), await addition.text()).toBe(true);
  const standaloneResponse = await request.post(
    `/api/projects/${fx.project.projectSlug}/agents/${encodeURIComponent(fx.agent)}/launch`,
    {
      headers: { Origin: origin },
      data: { workspace: "worktree", runnerId: fx.project.runnerId },
    },
  );

  expect(standaloneResponse.ok(), await standaloneResponse.text()).toBe(true);
  const { runId: standalone } = (await standaloneResponse.json()) as {
    runId: string;
  };

  expect(standalone).toEqual(expect.any(String));
  await expect
    .poll(() => artifact(standalone, "designer.txt"), { timeout: 120_000 })
    .toContain(fx.designMarker);
  const consumer = await artifact(standalone, "designer.txt");

  expect(consumer).toContain(fx.addition);
  expect(consumer).toContain(reference.receipt);
  const runIds = [design, coding, standalone];
  const settled = () =>
    singleValue<{ runId: string; status: string }[]>(
      `SELECT json_agg(json_build_object('runId',id,'status',status) ORDER BY id) AS value FROM runs WHERE id=ANY($1) AND project_id=$2`,
      [runIds, fx.project.projectId],
    );

  await expect
    .poll(
      async () => {
        for (const id of runIds) await assertActive(id);

        return (await settled())?.filter((row) =>
          ["Review", "Done"].includes(row.status),
        ).length;
      },
      { timeout: 60_000 },
    )
    .toBe(3);
  type SessionFact = {
    runId: string;
    acpSessionId: string;
    hostId: string;
    epoch: number;
  };
  const runFacts = await singleValue<SessionFact[]>(
    `SELECT json_agg(fact) AS value FROM (SELECT r.id AS "runId", i.acp_session_id AS "acpSessionId",
        i.execution_host_id AS "hostId",i.assignment_epoch AS epoch FROM runs r JOIN run_session_incarnations i ON i.run_id=r.id WHERE r.id = ANY($1) AND i.acp_session_id IS NOT NULL ORDER BY i.id) fact`,
    [[design, coding, standalone]],
  );

  for (const id of [design, coding, standalone])
    expect(runFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: id,
          acpSessionId: expect.any(String),
          hostId: expect.any(String),
        }),
      ]),
    );
  const bySession = new Map<string, string>();

  for (const row of runFacts ?? []) {
    const prior = bySession.get(row.acpSessionId);

    if (prior && prior !== row.runId)
      throw new Error("Different consumers shared an ACP session");
    bySession.set(row.acpSessionId, row.runId);
  }
  const pins = await singleValue(
    `SELECT json_agg(json_build_object('installId',i.id,'name',i.name,'revision',i.resolved_revision) ORDER BY i.name) AS value
     FROM package_installs i JOIN project_package_attachments a ON a.package_install_id=i.id
     WHERE i.id=ANY($1) AND a.project_id=$2`,
    [fx.installs, fx.project.projectId],
  );

  expect(pins).toHaveLength(3);
  for (const [name, content, contentType] of [
    ["prototype.html", prototype, "text/html"],
    [
      "verification.txt",
      await artifact(coding, "verification.txt"),
      "text/plain",
    ],
    ["designer.txt", consumer, "text/plain"],
  ]) {
    const path = testInfo.outputPath(name);

    await writeFile(path, content, "utf8");
    await testInfo.attach(name, { path, contentType });
  }
  const receiptPath = testInfo.outputPath("delivery-receipts.json");

  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        design,
        coding,
        standalone,
        pins,
        runFacts,
        settled: await settled(),
        shared,
        inherited,
        addition: fx.addition,
        reference: reference.receipt,
        designInventory: await inventory(design),
        codingInventory,
        prototype,
        consumer,
        questionId,
        proof,
      },
      null,
      2,
    ),
  );
  await testInfo.attach("delivery-receipts", {
    contentType: "application/json",
    path: receiptPath,
  });
});
