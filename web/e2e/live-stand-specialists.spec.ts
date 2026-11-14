import type { APIRequestContext, APIResponse } from "@playwright/test";

import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { canonicalCommandJson } from "../../runtime/command-json";
import {
  captureOwnedAdapterProcess,
  captureSupervisorProcessGroups,
} from "../test-support/capture-supervisor-process-groups";
import {
  findProcessIdentity,
  invocationFromEnvironment,
  invocationRecords,
  signalInvocationProcess,
} from "../test-support/process-invocation";

import { loadNativeCompanyBrainFixtures } from "./_seed/native-company-brain-fixtures";
import { singleValue, withE2EDb } from "./_seed/db";

import { parseAgentDefinition } from "@/lib/agents/definition";
import {
  knowledgeRecordSchema,
  knowledgeWitnessSchema,
} from "@/lib/brain/knowledge-read-types";
import { operationalEvidenceV2Schema } from "@/lib/run-results/operational-schema";
import {
  standComponentSchema,
  standTargetInputSchema,
} from "@/lib/stand-operations/target-types";

const id = z.object({ id: z.string() });
const installation = z.object({ companyId: z.string() });
const component = z
  .object({
    id: standComponentSchema.shape.id,
    serviceManager: standComponentSchema.shape.serviceManager,
    scope: standComponentSchema.shape.scope,
    user: standComponentSchema.shape.user,
    unit: standComponentSchema.shape.unit,
    actions: standComponentSchema.shape.actions,
    healthProbe: standComponentSchema.shape.healthProbe,
  })
  .strict();
const target = z
  .object({
    incarnationId: standTargetInputSchema.shape.incarnationId,
    endpoint: standTargetInputSchema.shape.endpoint,
    serverIdentity: standTargetInputSchema.shape.serverIdentity,
    caEnv: standTargetInputSchema.shape.caEnv,
    certificateEnv: standTargetInputSchema.shape.certificateEnv,
    keyEnv: standTargetInputSchema.shape.keyEnv,
    platformCredentialEnv: standTargetInputSchema.shape.platformCredentialEnv,
    helperCredentialEnv: standTargetInputSchema.shape.helperCredentialEnv,
    helperCertificateSha256:
      standTargetInputSchema.shape.helperCertificateSha256,
    enabled: z.literal(true),
    component,
  })
  .strict();
const binding = z.object({
  bindingId: z.string(),
  configRevision: z.number().int(),
});
const assignmentSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  inputRevision: z.number().int(),
  contextRevision: z.number().int(),
  status: z.string(),
  runIds: z.array(z.string()).min(1),
});
const terminalSnapshot = z.object({
  id: z.string(),
  status: z.string(),
  cause: z.string().nullable(),
  reason_codes: z.array(z.string()).nullable(),
  validation_diagnostics: z
    .array(z.object({ code: z.string(), path: z.string() }))
    .nullable(),
  result_reason: z.string().nullable(),
  credential_generations: z.array(
    z.object({
      nodeAttemptId: z.string().nullable(),
      issuedAt: z.string(),
      revokedAt: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

function required(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Stand pilot requires ${name}`);

  return value;
}

async function read<T>(
  response: APIResponse,
  schema: z.ZodType<T>,
): Promise<T> {
  expect(
    response.ok(),
    `${new URL(response.url()).pathname} returned HTTP ${response.status()}`,
  ).toBe(true);

  return schema.parse(await response.json());
}

async function grants(
  request: APIRequestContext,
  principalKind: "user" | "agent",
  principalId: string,
  actions: readonly string[],
) {
  return read(
    await request.post("/api/company/grants", {
      data: {
        principalKind,
        principalId,
        actions,
        idempotencyKey: randomUUID(),
      },
    }),
    installation,
  );
}

async function requireLiveWebProcess(excludePid?: number) {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("Stand interruption requires a test invocation");
  const records = await invocationRecords(invocation);

  for (const record of records) {
    if (record.kind !== "process" || record.role !== "web") continue;
    if (record.identity.pid === excludePid) continue;
    const identity = await findProcessIdentity(invocation, record.identity.pid);

    if (
      identity?.owned &&
      identity.inspected &&
      !identity.zombie &&
      identity.started === record.identity.started
    )
      return { invocation, identity, bootId: record.bootId };
  }
}

const acceptedDiagnostic = z.object({
  id: z.string(),
  childRunId: z.string(),
  inputRevision: z.number().int(),
  workRevision: z.number().int(),
  resultRevision: z.number().int(),
});

async function readAcceptedDiagnostic(assignmentId: string, runId: string) {
  return acceptedDiagnostic.parse(
    await singleValue<unknown>(
      `SELECT jsonb_build_object('id',work.id,'childRunId',work.child_run_id,
         'inputRevision',work.input_revision,'workRevision',work.work_revision,
         'resultRevision',decision.result_revision) AS value
       FROM specialist_work work JOIN specialist_work_decisions decision
         ON decision.work_id=work.id AND decision.work_revision=work.work_revision
       WHERE work.assignment_id=$1 AND work.parent_run_id=$2
         AND work.decision_state='accepted' AND decision.decision='accept'`,
      [assignmentId, runId],
    ),
  );
}

async function assertStandRuntimeModels(
  runIds: readonly string[],
  runner: Readonly<{ id: string; model: string }>,
) {
  const witnessed = await withE2EDb(async (pool) => {
    const { rows } = await pool.query(
      `SELECT session.run_id AS "runId",session.acp_session_id AS "sessionId",
        session.runner_id AS "runnerId", session.runner_snapshot->>'model' AS "configuredModel",
        ARRAY(SELECT DISTINCT event.payload->>'model' FROM execution_events event
          JOIN run_session_incarnations incarnation ON incarnation.run_session_id=session.id
            AND incarnation.run_id=event.run_id AND incarnation.execution_host_id=event.execution_host_id
            AND incarnation.host_session_id=event.host_session_id
          WHERE event.run_id=session.run_id AND event.source='host' AND event.event_type='usage.recorded'
            AND jsonb_typeof(event.payload->'model')='string'
          ORDER BY event.payload->>'model') AS "reportedModels"
       FROM run_sessions session WHERE session.run_id=ANY($1::text[]) AND session.acp_session_id IS NOT NULL
       ORDER BY session.run_id,session.acp_session_id`,
      [runIds],
    );

    return z
      .array(
        z.object({
          runId: z.string(),
          sessionId: z.string(),
          runnerId: z.string(),
          configuredModel: z.string(),
          reportedModels: z.array(z.string()),
        }),
      )
      .parse(rows);
  });

  expect(new Set(witnessed.map((row) => row.runId))).toEqual(new Set(runIds));
  const projects = join(required("CLAUDE_CONFIG_DIR"), "projects");
  const projectPaths = (await readdir(projects, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => join(projects, item.name));
  const transcripts = (
    await Promise.all(
      projectPaths.map(async (directory) =>
        (await readdir(directory)).map((file) => ({ directory, file })),
      ),
    )
  ).flat();
  const assistantFrame = z.object({
    type: z.literal("assistant"),
    message: z.object({ model: z.string() }),
  });
  const proof = [];

  for (const session of witnessed) {
    expect(session.runnerId).toBe(runner.id);
    expect(session.configuredModel).toBe(runner.model);
    expect(
      session.reportedModels.every((model) => model === runner.model),
    ).toBe(true);
    const matches = transcripts.filter(
      ({ file }) => file === `${session.sessionId}.jsonl`,
    );

    expect(matches, `Exact ACP transcript for ${session.runId}`).toHaveLength(
      1,
    );
    const transcript = await readFile(
      join(matches[0]!.directory, matches[0]!.file),
      "utf8",
    );
    const sdkModels = [
      ...new Set(
        transcript
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            const frame = assistantFrame.safeParse(JSON.parse(line));

            return frame.success && frame.data.message.model !== "<synthetic>"
              ? [frame.data.message.model]
              : [];
          }),
      ),
    ];

    expect(
      sdkModels,
      `Actual response model for ${session.runId}/${session.sessionId}`,
    ).toEqual([runner.model]);
    proof.push({ ...session, sdkModels });
  }

  return proof;
}

async function interruptDiagnostic(assignmentId: string, runId: string) {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("Stand interruption requires a test invocation");
  const supervisorUrl = `http://127.0.0.1:${z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(required("MAISTER_SUPERVISOR_PORT"))}`;
  const diagnosticAppointment = async () =>
    z
      .object({
        childRunId: z.string(),
        workId: z.string(),
        revision: z.number().int(),
        sessionId: z.string(),
        placementId: z.string(),
        placementEpoch: z.number().int(),
      })
      .nullable()
      .parse(
        await singleValue<unknown>(
          `SELECT jsonb_build_object('childRunId',work.child_run_id,'workId',work.id,
          'revision',work.work_revision,'sessionId',session.host_session_id,
          'placementId',placement.id,'placementEpoch',placement.epoch) AS value
         FROM specialist_work work JOIN run_sessions session ON session.run_id=work.child_run_id
         JOIN execution_assignments placement ON placement.id=session.execution_assignment_id
         JOIN execution_commands prompt ON prompt.run_id=work.child_run_id AND prompt.execution_assignment_id=placement.id
          AND prompt.kind='session.prompt' AND prompt.state='accepted'
         WHERE work.assignment_id=$1 AND work.parent_run_id=$2
          AND work.logical_work_id='diagnose-stand' AND session.host_session_id IS NOT NULL`,
          [assignmentId, runId],
        ),
      );

  await expect
    .poll(diagnosticAppointment, { timeout: 180_000, intervals: [150, 300] })
    .not.toBeNull();
  const work = (await diagnosticAppointment())!;
  const inventory = await fetch(
    `${supervisorUrl}/sessions?runId=${encodeURIComponent(work.childRunId)}`,
    { signal: AbortSignal.timeout(3_000) },
  );

  expect(inventory.ok).toBe(true);
  expect(inventory.headers.get("X-Maister-Session-Ownership-Version")).toBe(
    "1",
  );
  const session = z
    .array(z.object({ sessionId: z.string(), pid: z.number().int().gt(1) }))
    .parse(await inventory.json())
    .find((row) => row.sessionId === work.sessionId);

  if (!session)
    throw new Error("The diagnostic session is absent from its host");
  const gate = await findProcessIdentity(invocation, session.pid);
  const supervisor = gate && (await findProcessIdentity(invocation, gate.ppid));

  if (
    !gate?.owned ||
    !gate.inspected ||
    !supervisor?.owned ||
    !supervisor.inspected
  )
    throw new Error(
      "The diagnostic gate and supervisor must belong to this invocation",
    );
  const { adapter } = await captureOwnedAdapterProcess({
    invocation,
    supervisor: {
      url: supervisorUrl,
      pid: supervisor.pid,
      captureOwnedSessionGroups: () =>
        captureSupervisorProcessGroups({
          invocation,
          url: supervisorUrl,
          supervisorPid: supervisor.pid,
          runtimeRoot: join(
            required("MAISTER_WORKTREES_ROOT"),
            "runtime",
            "supervisor",
          ),
          bootId: supervisor.started,
          logFile: join(invocation.directory, "stand-adapter-interruption.log"),
          caseName: "stand-diagnostic-interruption",
        }),
    },
    sessionId: work.sessionId,
    expected: {
      runId: work.childRunId,
      assignmentId: work.placementId,
      assignmentEpoch: work.placementEpoch,
    },
  });

  await signalInvocationProcess(invocation, adapter, "SIGKILL");
  await expect
    .poll(
      async () => {
        const identity = await findProcessIdentity(invocation, adapter.pid);

        return (
          !identity || identity.zombie || identity.started !== adapter.started
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  return { ...work, adapterPid: adapter.pid };
}

test("QL-CBX-04 pinned GLM-5.3 specialists diagnose, restart and verify one disposable stand", async ({
  request,
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(1_500_000);
  const checkRecovery = process.env.E2E_STAND_RECOVERY === "1";
  const checkConflict = process.env.E2E_STAND_RESOURCE_CONFLICT === "1";
  const checkClarification = process.env.E2E_STAND_CLARIFICATION === "1";
  const checkCoordinatorInterruption =
    process.env.E2E_STAND_RESTART_WEB_ON_SIGKILL === "1";
  const checkDiagnosticInterruption =
    process.env.E2E_STAND_KILL_DIAGNOSTIC === "1";
  const sourceUrl = required("E2E_STAND_GIT_URL");
  const tag = required("E2E_STAND_TAG");
  const expectedCommit = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(required("E2E_STAND_COMMIT"));
  const configured = target.parse(
    JSON.parse(await readFile(required("E2E_STAND_TARGET_CONFIG"), "utf8")),
  );
  const runnerInput: unknown = JSON.parse(
    await readFile(required("E2E_LIVE_RUNNER_CONFIG"), "utf8"),
  );
  const runner = z
    .object({ id: z.string(), model: z.literal("glm-5.3") })
    .parse(runnerInput);
  const admin = loadNativeCompanyBrainFixtures().users.admin;
  const origin = new URL(baseURL ?? required("E2E_STAND_WEB_ORIGIN")).origin;

  expect(configured.enabled).toBe(true);
  expect(configured.component.unit).toBe("maister-disposable-pilot.service");
  expect(configured.component.actions).toEqual(
    expect.arrayContaining(["inspect", "logs", "restart", "verify"]),
  );
  expect(
    await withE2EDb(
      async (pool) =>
        (await pool.query("SELECT current_database() AS name")).rows[0]?.name,
    ),
  ).toBe("maister_e2e");
  const authority = await grants(request, "user", admin.id, [
    "knowledge:read",
    "knowledge:propose",
    "knowledge:review",
    "specialists:read",
    "specialists:manage",
    "assignments:read",
    "assignments:submit",
    "assignments:update",
    "assignments:answer",
    "assignments:accept",
    "assignments:cancel",
    "assignments:recover",
    "assignments:delegate",
    "targets:read",
    "targets:logs",
    "targets:restart",
    "targets:recover",
    "targets:manage",
  ]);
  const owner = { kind: "company", companyId: authority.companyId } as const;
  const source = await read(
    await request.post("/api/admin/package-sources", {
      data: { url: sourceUrl, kind: "git" },
    }),
    id,
  );
  const installed = await read(
    await request.post("/api/admin/package-installs", {
      data: { sourceId: source.id, name: "stand-operations", version: tag },
    }),
    id,
  );

  await read(
    await request.post(`/api/admin/package-installs/${installed.id}/trust`),
    z.object({ ok: z.literal(true) }),
  );
  await read(
    await request.post("/api/admin/acp-runners", { data: runnerInput }),
    z.object({ id: z.literal(runner.id) }),
  );
  const pinned = await withE2EDb(async (pool) => {
    const { rows } = await pool.query(
      "SELECT package.resolved_revision,package.installed_path,flow.id AS flow_id,flow.manifest_digest FROM package_installs package JOIN flow_revisions flow ON flow.resolved_revision=package.resolved_revision AND flow.flow_ref_id='stand-maintenance' WHERE package.id=$1 AND flow.exec_trust='trusted'",
      [installed.id],
    );

    return z
      .object({
        resolved_revision: z.literal(expectedCommit),
        installed_path: z.string(),
        flow_id: z.string(),
        manifest_digest: z.string(),
      })
      .parse(rows[0]);
  });

  await withE2EDb(async (pool) => {
    await pool.query(
      "UPDATE platform_runtime_settings SET default_runner_id=$1 WHERE id='singleton'",
      [runner.id],
    );
  });
  const coordinatorActions = [
    "assignments:read",
    "assignments:update",
    "assignments:delegate",
    "assignments:accept",
    "knowledge:read",
    "targets:read",
    "targets:logs",
    "targets:restart",
  ];
  const diagnosticActions = [
    "assignments:read",
    "knowledge:read",
    "targets:read",
    "targets:logs",
  ];
  const bind = async (
    role: "coordinator" | "diagnostic" | "inspector",
    actions: readonly string[],
  ) => {
    const agentId = `stand-operations:${role}`;
    const definition = parseAgentDefinition(
      agentId,
      await readFile(
        join(pinned.installed_path, "maister-agents", `${role}.md`),
        "utf8",
      ),
    );
    const { taskQualification, ...legacy } = definition;
    const definitionSha256 = createHash("sha256")
      .update(
        canonicalCommandJson(
          taskQualification ? { ...legacy, taskQualification } : legacy,
        ),
      )
      .digest("hex");

    await grants(request, "agent", agentId, actions);

    return read(
      await request.post(
        `/api/specialists/${encodeURIComponent(agentId)}/bindings`,
        {
          data: {
            owner,
            packageInstallId: installed.id,
            packageRevision: expectedCommit,
            definitionSha256,
            configuration: {},
            grantActions: actions,
            runnerId: runner.id,
            executionPolicy: {
              preset: "assisted",
              overrides: { budget: { tree: { maxTokens: 1_500_000 } } },
            },
            coordinatorFlowRevisionId:
              role === "coordinator" ? pinned.flow_id : null,
            enabled: true,
            idempotencyKey: randomUUID(),
          },
        },
      ),
      binding,
    );
  };
  const coordinator = await bind("coordinator", coordinatorActions);

  const diagnostic = await bind("diagnostic", diagnosticActions);
  const inspector = await bind("inspector", [
    "assignments:read",
    "knowledge:read",
    "targets:read",
  ]);

  await read(
    await request.post("/api/company/flow-bindings", {
      headers: { Origin: origin },
      data: {
        owner,
        specialistBindingId: coordinator.bindingId,
        specialistRevision: coordinator.configRevision,
        flowRevisionId: pinned.flow_id,
        manifestSha256: pinned.manifest_digest,
        execution: { workspace: "none", completion: "result" },
        roleMappings: { operator: [admin.id] },
        enabled: true,
        idempotencyKey: randomUUID(),
      },
    }),
    id,
  );
  const procedure =
    "Inspect the configured disposable service and bounded logs. Delegate ambiguous diagnosis. Restart the appointed component once after exact operator approval, then run the independent health probe.";
  const proof = await read(
    await request.post("/api/knowledge/sources", {
      data: {
        owner,
        title: "Disposable qualification runbook",
        content: procedure,
        reportedSourceVersion: expectedCommit,
        idempotencyKey: randomUUID(),
      },
    }),
    knowledgeWitnessSchema,
  );
  const proposal = await read(
    await request.post("/api/knowledge/proposals", {
      data: {
        idempotencyKey: randomUUID(),
        content: {
          owner,
          change: "add",
          title: "Disposable qualification runbook",
          kind: "procedure",
          assertion: procedure,
          basis: "observed",
          evidence: [
            {
              relation: "supports",
              reference: {
                kind: "witness",
                id: proof.id,
                sha256: proof.sha256,
              },
            },
          ],
          missingEvidence: [],
          limitations: ["Configured disposable qualification component only."],
        },
      },
    }),
    id,
  );

  await read(
    await request.post(`/api/knowledge/proposals/${proposal.id}/decision`, {
      data: {
        expectedRevision: 1,
        decision: "accept",
        reason: "Publish the controlled test procedure.",
        idempotencyKey: randomUUID(),
      },
    }),
    z.object({ status: z.literal("accepted") }),
  );
  const runbook = await read(
    await request.get(`/api/knowledge/proposals/${proposal.id}`),
    z.object({
      status: z.literal("accepted"),
      acceptedRecordId: z.string(),
      acceptedRecordRevision: z.number().int(),
    }),
  );
  const { component: configuredComponent, ...connection } = configured;
  const aliasId = `${configuredComponent.id}-alias`;
  const runbookReference = {
    recordId: runbook.acceptedRecordId,
    revision: runbook.acceptedRecordRevision,
    witnessId: proof.id,
  };
  const stand = await read(
    await request.post("/api/stands", {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: {
        ...connection,
        owner,
        components: [
          {
            ...configuredComponent,
            runbook: runbookReference,
          },
          ...(checkConflict
            ? [
                {
                  ...configuredComponent,
                  id: aliasId,
                  runbook: runbookReference,
                },
              ]
            : []),
        ],
      },
    }),
    id,
  );
  const objective =
    "Diagnose ambiguous fixture symptoms, restart the configured disposable component once and verify health.";
  const expectedOutcome =
    "One confirmed restart, one independently healthy probe and an attributable reusable observation.";

  const requestBody = {
    owner,
    specialistBindingId: coordinator.bindingId,
    objective,
    expectedOutcome,
    input:
      "Obtain an independent diagnostic before review. Prepare a reusable observation.",
    targetIds: [stand.id],
    inputRefs: [],
    constraints: [],
    verification: [
      { kind: "effect", referenceId: stand.id, required: true },
      { kind: "health", referenceId: stand.id, required: true },
    ],
    idempotencyKey: randomUUID(),
  };
  const submit = async () => {
    if (checkClarification)
      return {
        body: requestBody,
        assignment: await read(
          await request.post("/api/specialist-assignments", {
            data: requestBody,
            headers: { Origin: origin },
          }),
          assignmentSchema,
        ),
      };

    await page.goto("/specialist-assignments");
    await page
      .getByLabel("Responsible specialist")
      .selectOption(coordinator.bindingId);
    await page
      .getByLabel("Target component")
      .selectOption(`${stand.id}/${configuredComponent.id}`);
    await page.getByLabel("Objective", { exact: true }).fill(objective);
    await page
      .getByLabel("Expected outcome", { exact: true })
      .fill(expectedOutcome);
    await page
      .getByLabel("Additional instructions")
      .fill(
        "Obtain the diagnostic specialist's bounded independent analysis before operator review. Keep the original operation on reconciliation and wait for approval. Prepare a reusable knowledge draft.",
      );

    const submitted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/specialist-assignments" &&
        response.request().method() === "POST",
    );

    await page
      .getByRole("button", { name: "Submit assignment", exact: true })
      .click();
    const submission = await submitted;

    expect(submission.status()).toBe(201);

    return {
      assignment: assignmentSchema.parse(await submission.json()),
      body: submission.request().postDataJSON() as unknown,
    };
  };
  const { assignment, body } = await submit();
  const duplicate = await read(
    await request.post("/api/specialist-assignments", {
      data: body,
      headers: { Origin: origin },
    }),
    assignmentSchema,
  );
  const runId = assignment.runIds[0]!;

  expect(duplicate.id).toBe(assignment.id);
  expect(duplicate.runIds).toEqual([runId]);
  const browserLocaleErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("MISSING_FORMAT"))
      browserLocaleErrors.push(message.text());
  });
  if (checkClarification) {
    const retainedQuestion = () =>
      singleValue<{ id: string; prompt: string }>(
        `SELECT jsonb_build_object('id',id,'prompt',prompt) AS value FROM hitl_requests
       WHERE run_id=$1 AND specialist_assignment_id=$2 AND kind='agent_question'
       AND activation_state='active' AND responded_at IS NULL AND superseded_at IS NULL`,
        [runId, assignment.id],
      );

    await expect.poll(retainedQuestion, { timeout: 180_000 }).not.toBeNull();
    const question = (await retainedQuestion())!;

    expect(
      await singleValue<number>(
        "SELECT count(*)::int AS value FROM stand_operations WHERE assignment_id=$1",
        [assignment.id],
      ),
    ).toBe(0);
    await page.goto(`/specialist-assignments/${assignment.id}`);
    await page.getByRole("link", { name: "Open Inbox", exact: true }).click();
    const questionCard = page
      .getByTestId("hitl-card")
      .filter({ hasText: question.prompt });

    await questionCard
      .getByRole("button", { name: "Answer clarification", exact: true })
      .click();
    await questionCard
      .getByRole("textbox", { name: /^Component ID(?: \*)?$/ })
      .fill(configuredComponent.id);
    const answerResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/runs/${runId}/hitl/${question.id}/respond` &&
        response.request().method() === "POST",
    );

    await questionCard
      .getByTestId("hitl-panel-context")
      .getByRole("button", { name: "Answer clarification", exact: true })
      .click();
    expect((await answerResponse).ok()).toBe(true);
    const acceptedInput = z
      .object({
        source: z.literal(assignment.inputRevision),
        answer: z.literal(assignment.inputRevision + 1),
        response: z.object({ componentId: z.literal(configuredComponent.id) }),
      })
      .parse(
        await singleValue<unknown>(
          `SELECT jsonb_build_object('source',specialist_input_revision,'answer',specialist_answer_input_revision,
        'response',response) AS value FROM hitl_requests WHERE id=$1 AND run_id=$2 AND specialist_assignment_id=$3`,
          [question.id, runId, assignment.id],
        ),
      );

    await testInfo.attach("stand-clarification-proof", {
      body: JSON.stringify({
        assignmentId: assignment.id,
        runId,
        questionId: question.id,
        ...acceptedInput,
      }),
      contentType: "application/json",
    });
  }
  if (checkDiagnosticInterruption) {
    const killed = await interruptDiagnostic(assignment.id, runId);

    await testInfo.attach("stand-diagnostic-interruption", {
      body: JSON.stringify({ assignmentId: assignment.id, runId, ...killed }),
      contentType: "application/json",
    });
  }
  const approvedStep = async () =>
    withE2EDb(async (pool) => {
      const terminal = await pool.query(
        `SELECT execution.id,execution.status,
          execution.operational_terminal->>'cause' AS cause,
          execution.operational_terminal->'reasonCodes' AS reason_codes,
          execution.operational_terminal->'validationDiagnostics' AS validation_diagnostics,
          result.invalid_reason AS result_reason,
          coalesce(credentials.generations,'[]'::jsonb) AS credential_generations
        FROM runs execution
        LEFT JOIN LATERAL (
          SELECT invalid_reason FROM run_results WHERE run_id=execution.id ORDER BY revision DESC LIMIT 1
        ) result ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'nodeAttemptId',knowledge_node_attempt_id,
            'issuedAt',created_at,
            'revokedAt',revoked_at,
            'reason',revocation_reason
          ) ORDER BY created_at) AS generations
          FROM project_tokens WHERE company_run_id=execution.id
        ) credentials ON true
        WHERE (execution.id=$1 OR execution.parent_run_id=$1)
          AND execution.status IN ('Failed','Crashed','Abandoned')
        ORDER BY (execution.id=$1) LIMIT 1`,
        [runId],
      );

      if (terminal.rows[0]) {
        const snapshot = terminalSnapshot.parse(terminal.rows[0]);

        await testInfo.attach("pilot-terminal-diagnostics", {
          body: JSON.stringify(snapshot),
          contentType: "application/json",
        });
        throw new Error(
          `Pilot terminated before approval ${JSON.stringify(snapshot)}`,
        );
      }
      const stopped = await pool.query<{ step_id: string; kind: string }>(
        "SELECT step_id,kind FROM hitl_requests WHERE run_id=$1 AND responded_at IS NULL AND superseded_at IS NULL AND step_id<>'authorize'",
        [runId],
      );

      if (stopped.rows[0]) {
        const { step_id, kind } = stopped.rows[0];

        throw new Error(`Pilot stopped at ${step_id} with ${kind}`);
      }
      const { rows } = await pool.query(
        "SELECT operation.id,operation.revision,operation.request_digest,hitl.id AS hitl_id FROM stand_operations operation JOIN hitl_requests hitl ON hitl.run_id=$2 AND hitl.step_id='authorize' AND hitl.responded_at IS NULL WHERE operation.assignment_id=$1 AND operation.action='restart'",
        [assignment.id, runId],
      );

      return z
        .object({
          id: z.string(),
          revision: z.number().int(),
          request_digest: z.string(),
          hitl_id: z.string(),
        })
        .optional()
        .parse(rows[0]);
    });

  await expect.poll(approvedStep, { timeout: 720_000 }).toBeDefined();
  const operation = (await approvedStep())!;
  const preserved = checkCoordinatorInterruption
    ? await readAcceptedDiagnostic(assignment.id, runId)
    : undefined;

  if (preserved) {
    const oldWeb = await requireLiveWebProcess();

    if (!oldWeb)
      throw new Error("Could not prove the original Web process identity");
    await signalInvocationProcess(
      oldWeb.invocation,
      oldWeb.identity,
      "SIGKILL",
    );
    await expect
      .poll(() => requireLiveWebProcess(oldWeb.identity.pid), {
        timeout: 150_000,
      })
      .toBeDefined();
    const newWeb = (await requireLiveWebProcess(oldWeb.identity.pid))!;

    expect(newWeb.bootId).not.toBe(oldWeb.bootId);
    await expect
      .poll(
        async () => {
          try {
            return (
              await request.get(
                `/api/specialist-assignments/${assignment.id}`,
                {
                  timeout: 3_000,
                },
              )
            ).status();
          } catch (error) {
            if (
              error instanceof Error &&
              /ECONNREFUSED|ECONNRESET/.test(error.message)
            )
              return undefined;
            throw error;
          }
        },
        { timeout: 150_000 },
      )
      .toBe(200);
    expect(await approvedStep()).toEqual(operation);
    expect(await readAcceptedDiagnostic(assignment.id, runId)).toEqual(
      preserved,
    );
    await testInfo.attach("stand-coordinator-interruption-proof", {
      body: JSON.stringify({
        assignmentId: assignment.id,
        runId,
        operationId: operation.id,
        oldWebPid: oldWeb.identity.pid,
        newWebPid: newWeb.identity.pid,
        acceptedDiagnostic: preserved,
      }),
      contentType: "application/json",
    });
  }

  if (checkConflict) {
    const contender = await read(
      await request.post("/api/specialist-assignments", {
        data: {
          ...requestBody,
          specialistBindingId: diagnostic.bindingId,
          objective:
            "Assess the competing selector for the same disposable component.",
          input: `Component ID: ${aliasId}`,
          idempotencyKey: randomUUID(),
        },
        headers: { Origin: origin },
      }),
      assignmentSchema,
    );

    expect(contender.id).not.toBe(assignment.id);
    const contenderCurrent = await read(
      await request.get(`/api/specialist-assignments/${contender.id}`),
      assignmentSchema,
    );
    const conflicting = await request.post(
      `/api/specialist-assignments/${contender.id}/operations`,
      {
        headers: { Origin: origin },
        data: {
          expectedRevision: contenderCurrent.revision,
          inputRevision: contender.inputRevision,
          componentId: aliasId,
          action: "restart",
          idempotencyKey: randomUUID(),
        },
      },
    );

    expect(conflicting.status()).toBe(409);
    expect(await conflicting.json()).toMatchObject({
      details: { reason: "resource_conflict" },
    });
    expect(
      await singleValue<number>(
        "SELECT count(*)::int AS value FROM stand_operations WHERE assignment_id=$1",
        [contender.id],
      ),
    ).toBe(0);
    expect(
      await singleValue<number>(
        "SELECT count(*)::int AS value FROM execution_commands WHERE kind='stand.dispatch' AND run_id=$1",
        [contender.runIds[0]],
      ),
    ).toBe(0);
    await testInfo.attach("stand-conflict-proof", {
      body: JSON.stringify({
        contenderId: contender.id,
        operationId: operation.id,
        aliasId,
        status: conflicting.status(),
      }),
      contentType: "application/json",
    });
  }

  const decisionPage = await page.goto(
    `/specialist-assignments/${assignment.id}`,
  );

  expect(decisionPage?.ok()).toBe(true);
  const approval = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Approve this restart",
      exact: true,
    }),
  });

  await expect(approval).toContainText(operation.request_digest);
  await approval
    .getByLabel("Reason", { exact: true })
    .fill("Authorize this exact disposable qualification restart.");
  const approvalResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/stand-operations/${operation.id}/approval` &&
      response.request().method() === "POST",
  );

  await approval
    .getByRole("button", { name: "Approve this restart", exact: true })
    .click();
  const approved = await approvalResponse;

  expect(approved.ok()).toBe(true);
  expect(await approved.json()).toMatchObject({ operationId: operation.id });
  await expect(
    page.getByText("Restart approval recorded", { exact: false }),
  ).toBeVisible();
  await read(
    await request.post(`/api/runs/${runId}/hitl/${operation.hitl_id}/respond`, {
      data: { response: { decision: "continue" } },
    }),
    z.unknown(),
  );
  if (checkRecovery) {
    const readOperation = async () =>
      read(
        await request.get(`/api/stand-operations/${operation.id}`),
        z.object({
          id: z.literal(operation.id),
          effectState: z.string(),
          revision: z.number().int(),
          receiptIds: z.array(z.string()),
        }),
      );

    await expect
      .poll(async () => (await readOperation()).effectState, {
        timeout: 210_000,
      })
      .toBe("unknown");
    const unknown = await readOperation();

    expect(unknown.receiptIds).toEqual([]);
    const recoveryView = await page.goto(
      `/specialist-assignments/${assignment.id}`,
    );

    expect(recoveryView?.ok()).toBe(true);
    const reconciliationResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/stand-operations/${operation.id}/reconcile` &&
        response.request().method() === "POST",
    );

    await page
      .getByRole("button", { name: "Check the original receipt", exact: true })
      .click();
    const reconciliation = await reconciliationResponse;

    expect(reconciliation.status()).toBe(200);
    expect(reconciliation.request().postDataJSON()).toEqual({
      expectedRevision: unknown.revision,
    });
    const reconciled = z
      .object({
        id: z.literal(operation.id),
        effectState: z.literal("confirmed_applied"),
        receiptIds: z.tuple([z.uuid()]),
      })
      .parse(await reconciliation.json());
    const dispatch = await singleValue<{
      commands: number;
      permits: number;
      distinctInvocations: boolean;
    }>(
      `SELECT jsonb_build_object('commands',(SELECT count(*) FROM execution_commands WHERE kind='stand.dispatch' AND run_id=$1),
        'permits',(SELECT count(*) FROM stand_authorization_permits WHERE operation_id=$2 AND purpose='dispatch'),
        'distinctInvocations', receipt->>'beforeInvocation' <> receipt->>'afterInvocation') AS value
       FROM stand_operation_receipts WHERE id=$3 AND operation_id=$2`,
      [runId, operation.id, reconciled.receiptIds[0]],
    );

    expect(dispatch).toEqual({
      commands: 1,
      permits: 1,
      distinctInvocations: true,
    });
    await testInfo.attach("stand-reconciliation-proof", {
      body: JSON.stringify({
        operationId: operation.id,
        runId,
        unknown,
        reconciled,
        dispatch,
      }),
      contentType: "application/json",
    });
  }
  const current = () =>
    request
      .get(`/api/specialist-assignments/${assignment.id}`)
      .then((response) => read(response, assignmentSchema));

  try {
    await expect
      .poll(
        async () => {
          const head = await current();

          if (head.status === "awaiting_acceptance") return head.status;
          const execution = await singleValue<string>(
            "SELECT status AS value FROM runs WHERE id=$1",
            [runId],
          );

          if (execution && /^(Failed|Crashed|Abandoned)$/.test(execution))
            throw new Error(
              `The root Run settled ${execution} before assignment acceptance`,
            );

          return head.status;
        },
        { timeout: 420_000 },
      )
      .toBe("awaiting_acceptance");
  } catch (error) {
    const snapshot = await withE2EDb(async (pool) => {
      const [execution, results, nodes] = await Promise.all([
        pool.query(
          "SELECT status,current_step_id,operational_terminal->>'cause' AS cause,operational_terminal->'reasonCodes' AS reasons FROM runs WHERE id=$1",
          [runId],
        ),
        pool.query(
          "SELECT revision,validity,invalid_reason FROM run_results WHERE run_id=$1 ORDER BY revision",
          [runId],
        ),
        pool.query(
          "SELECT node_id,status FROM node_attempts WHERE run_id=$1 ORDER BY started_at,node_id",
          [runId],
        ),
      ]);

      return {
        execution: execution.rows[0],
        results: results.rows,
        nodes: nodes.rows,
      };
    });

    await testInfo.attach("pilot-settlement-diagnostics", {
      body: JSON.stringify(snapshot),
      contentType: "application/json",
    });
    throw error;
  }
  const result = await withE2EDb(async (pool) => {
    const { rows } = await pool.query(
      "SELECT result.revision,result.value,run.project_id,run.task_id,run.company_id FROM run_results result JOIN runs run ON run.id=result.run_id WHERE run.id=$1 AND result.validity='valid'",
      [runId],
    );

    return z
      .object({
        revision: z.number().int(),
        value: operationalEvidenceV2Schema,
        project_id: z.null(),
        task_id: z.null(),
        company_id: z.literal(owner.companyId),
      })
      .parse(rows[0]);
  });

  expect(result.value.outcome).toBe("success");
  expect(result.value.operationIds).toEqual([operation.id]);
  expect(result.value.verificationIds).toHaveLength(1);
  expect(result.value.findings.knowledgeProposals.length).toBeGreaterThan(0);
  if (preserved)
    expect(await readAcceptedDiagnostic(assignment.id, runId)).toEqual(
      preserved,
    );
  const execution = await withE2EDb(
    async (pool) =>
      (
        await pool.query(
          "SELECT (SELECT count(*)::int FROM stand_operations WHERE assignment_id=$1 AND action='restart') AS operations,(SELECT count(*)::int FROM specialist_work WHERE assignment_id=$1 AND decision_state='accepted') AS accepted_children,(SELECT count(*)::int FROM stand_verifications WHERE operation_id=$2 AND state='healthy') AS healthy",
          [assignment.id, operation.id],
        )
      ).rows[0],
  );

  expect(execution).toEqual({
    operations: 1,
    accepted_children: 1,
    healthy: 1,
  });
  const detail = await page.goto(`/specialist-assignments/${assignment.id}`);

  expect(detail?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: objective })).toBeVisible();
  const acceptance = page.locator("form").filter({
    has: page.getByRole("heading", {
      name: "Accept verified outcome",
      exact: true,
    }),
  });

  await acceptance
    .getByLabel("Reason", { exact: true })
    .fill("Independent health and exact restart receipt verified.");
  const acceptanceResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/specialist-assignments/${assignment.id}/acceptance` &&
      response.request().method() === "POST",
  );

  await acceptance
    .getByRole("button", { name: "Accept verified outcome", exact: true })
    .click();
  const accepted = await acceptanceResponse;

  expect(accepted.ok()).toBe(true);
  expect(await accepted.json()).toMatchObject({ status: "completed" });
  const originDelivery = () =>
    singleValue<string>(
      `SELECT notice.assignment_delivery_id AS value
       FROM inbox_items notice JOIN specialist_delivery_receipts receipt
         ON receipt.id=notice.assignment_delivery_id
       WHERE notice.recipient_type='user' AND notice.recipient_id=$1
         AND receipt.assignment_id=$2 AND receipt.run_id=$3 AND receipt.result_revision=$4`,
      [admin.id, assignment.id, runId, result.revision],
    );

  await expect.poll(originDelivery, { timeout: 120_000 }).not.toBeNull();
  const deliveryId = await originDelivery();

  await expect(
    page.getByRole("button", { name: "Submit retained knowledge drafts" }),
  ).toBeVisible();
  await page.getByText("Verification receipts (1)", { exact: true }).click({
    timeout: 20_000,
  });
  await expect(
    page.getByText(result.value.verificationIds[0]!, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Submit retained knowledge drafts" })
    .click({ timeout: 20_000 });
  const proposalLink = page.getByRole("link", {
    name: "Open proposal 1",
    exact: true,
  });
  const writeBackAlert = page
    .locator("section")
    .filter({
      has: page.getByRole("button", {
        name: "Submit retained knowledge drafts",
      }),
    })
    .getByRole("alert");

  await expect(proposalLink.or(writeBackAlert)).toBeVisible({
    timeout: 20_000,
  });
  if (!(await proposalLink.isVisible()))
    throw new Error(
      `Knowledge write-back failed: ${await writeBackAlert.first().innerText()}`,
    );
  await proposalLink.click({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/knowledge\/proposals\/[^/]+$/);

  const proposalId = decodeURIComponent(
    new URL(page.url()).pathname.split("/").at(-1)!,
  );

  await expect(page.getByText("Pending review", { exact: true })).toBeVisible();
  const workProposal = await read(
    await request.get(`/api/knowledge/proposals/${proposalId}`),
    z.object({
      id: z.literal(proposalId),
      status: z.literal("pending"),
      attribution: z.object({
        kind: z.literal("user"),
        id: z.literal(admin.id),
        runId: z.literal(runId),
      }),
    }),
  );

  await page
    .getByLabel("Decision reason", { exact: true })
    .fill(
      "Publish the verified observation from the controlled maintenance pilot.",
    );
  await page
    .getByRole("button", { name: "Accept proposal", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Published record", exact: true })
    .click();
  await expect(page.getByText("Unconfirmed", { exact: true })).toBeVisible();
  const recordUrl = new URL(page.url());
  const recordId = decodeURIComponent(recordUrl.pathname.split("/").at(-1)!);
  const record = await read(
    await request.get(`/api/knowledge/${recordId}${recordUrl.search}`),
    knowledgeRecordSchema,
  );

  expect(record).toMatchObject({
    owner,
    attribution: { kind: "user", id: admin.id, runId },
    confirmation: { state: "unconfirmed" },
  });
  await testInfo.attach("stand-pilot-proof", {
    body: JSON.stringify(
      {
        packageTag: tag,
        packageCommit: expectedCommit,
        runner,
        assignmentId: assignment.id,
        runId,
        operationId: operation.id,
        resultRevision: result.revision,
        deliveryId,
        verificationIds: result.value.verificationIds,
        acceptedChildren: execution.accepted_children,
        knowledgeProposalId: workProposal.id,
        knowledgeRecordId: record.id,
        knowledgeRecordRevision: record.revision,
        knowledgeConfirmation: record.confirmation.state,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await page.goto("/settings/specialists");
  const recurring = page.locator("form").filter({
    has: page.getByRole("heading", {
      name: "Schedule a stand inspection",
      exact: true,
    }),
  });

  await recurring
    .getByLabel("Responsible specialist")
    .selectOption(inspector.bindingId);
  await recurring
    .getByLabel("Target component")
    .selectOption(`${stand.id}/${configuredComponent.id}`);
  await recurring.getByLabel("Cron expression").fill("0 0 1 1 *");
  await recurring.getByLabel("Time zone").fill("UTC");
  await recurring
    .getByLabel("Recurring inspection request")
    .fill(
      "Inspect the configured health. Keep unchanged healthy observations quiet.",
    );
  await recurring
    .getByRole("button", { name: "Enable scheduled inspection" })
    .click();
  await expect(recurring.getByRole("status")).toHaveText(
    "The inspection schedule is enabled.",
  );
  const scheduleId = await withE2EDb(async (pool) => {
    const found = await pool.query<{ id: string }>(
      "SELECT id FROM agent_schedules WHERE company_specialist_binding_id=$1 AND enabled AND stand_inspection->>'targetId'=$2",
      [inspector.bindingId, stand.id],
    );

    expect(found.rows).toHaveLength(1);
    const selected = found.rows[0]!.id;

    await pool.query(
      "UPDATE agent_schedules SET next_fire_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [selected],
    );

    return selected;
  });
  const scheduled = async () =>
    withE2EDb(async (pool) => {
      const failure = await pool.query<{
        run_id: string;
        status: string;
        reason: string | null;
      }>(
        `SELECT execution.id AS run_id, execution.status, result.invalid_reason AS reason
         FROM agent_trigger_attempts invocation JOIN runs execution ON execution.id=invocation.original_run_id
         LEFT JOIN LATERAL (
           SELECT invalid_reason FROM run_results WHERE run_id=execution.id ORDER BY revision DESC LIMIT 1
         ) result ON true
         WHERE invocation.schedule_id=$1 AND execution.status IN ('Failed','Crashed','Abandoned')`,
        [scheduleId],
      );

      if (failure.rows[0]) {
        await testInfo.attach("stand-inspection-failure", {
          body: JSON.stringify(failure.rows[0]),
          contentType: "application/json",
        });
        throw new Error(
          "The scheduled inspection settled without a valid result",
        );
      }
      const found = await pool.query(
        `SELECT invocation.id AS attempt_id, execution.id AS run_id, execution.status,
        receipt.id AS delivery_id, event.fanout_at IS NOT NULL AND transport.id IS NULL AS suppressed,
        operation.id AS operation_id, probe.id AS verification_id,
        (SELECT count(*)::int FROM execution_commands WHERE kind='stand.dispatch' AND run_id=execution.id) AS commands
       FROM agent_trigger_attempts invocation
       JOIN runs execution ON execution.id=invocation.original_run_id
       JOIN specialist_delivery_receipts receipt ON receipt.run_id=execution.id
       JOIN webhook_events event ON event.id=receipt.outbox_event_id
       LEFT JOIN webhook_deliveries transport ON transport.specialist_delivery_id=receipt.id
       JOIN stand_operations operation ON operation.assignment_id=receipt.assignment_id AND operation.action='inspect'
         AND operation.effect_state='not_dispatched'
       JOIN stand_verifications probe ON probe.operation_id=operation.id AND probe.state='healthy' AND probe.effect_receipt_id IS NULL
       WHERE invocation.schedule_id=$1`,
        [scheduleId],
      );

      return z
        .object({
          attempt_id: z.uuid(),
          run_id: z.uuid(),
          status: z.string(),
          delivery_id: z.uuid(),
          suppressed: z.boolean(),
          operation_id: z.uuid(),
          verification_id: z.uuid(),
          commands: z.literal(0),
        })
        .optional()
        .parse(found.rows[0]);
    });

  await expect
    .poll(scheduled, { timeout: 240_000 })
    .toMatchObject({ status: "Done", suppressed: true });
  const inspection = (await scheduled())!;

  await page.getByRole("button", { name: "Switch language to RU" }).click();
  await expect(
    page.getByRole("heading", { name: "Активные расписания проверок стенда" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Отключить расписание" }).click();
  await expect(
    page.getByRole("heading", { name: "Активные расписания проверок стенда" }),
  ).toHaveCount(0);
  expect(browserLocaleErrors).toEqual([]);
  await testInfo.attach("stand-inspection-proof", {
    body: JSON.stringify({ scheduleId, ...inspection }),
    contentType: "application/json",
  });
  const child = await readAcceptedDiagnostic(assignment.id, runId);
  const modelWitnesses = await assertStandRuntimeModels(
    [runId, child.childRunId, inspection.run_id],
    runner,
  );

  await testInfo.attach("stand-runtime-model-proof", {
    body: JSON.stringify(modelWitnesses),
    contentType: "application/json",
  });
});
