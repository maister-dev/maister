import type { APIRequestContext, APIResponse } from "@playwright/test";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { canonicalCommandJson } from "../../runtime/command-json";

import { loadNativeCompanyBrainFixtures } from "./_seed/native-company-brain-fixtures";
import { withE2EDb } from "./_seed/db";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { knowledgeWitnessSchema } from "@/lib/brain/knowledge-read-types";
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

test("QL-CBX-04 pinned GLM-5.3 specialists diagnose, restart and verify one disposable stand", async ({
  request,
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(900000);
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
    role: "coordinator" | "diagnostic",
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
            executionPolicy: { preset: "assisted" },
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

  await bind("diagnostic", diagnosticActions);
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
  const stand = await read(
    await request.post("/api/stands", {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: {
        ...connection,
        owner,
        components: [
          {
            ...configuredComponent,
            runbook: {
              recordId: runbook.acceptedRecordId,
              revision: runbook.acceptedRecordRevision,
              witnessId: proof.id,
            },
          },
        ],
      },
    }),
    id,
  );
  const body = {
    owner,
    specialistBindingId: coordinator.bindingId,
    objective:
      "Diagnose ambiguous fixture symptoms, restart the configured disposable component once and verify health.",
    expectedOutcome:
      "One confirmed restart, one independently healthy probe and an attributable reusable observation.",
    input: `Component ID: ${configuredComponent.id}. Obtain the diagnostic specialist's bounded independent analysis before requesting operator review. Prepare a reusable knowledge draft.`,
    targetIds: [stand.id],
    inputRefs: [
      {
        kind: "knowledge",
        id: runbook.acceptedRecordId,
        revision: runbook.acceptedRecordRevision,
      },
    ],
    constraints: [
      "Use the existing operation ID on reconciliation.",
      "Await the separate exact restart approval.",
    ],
    verification: [
      { kind: "effect", referenceId: stand.id, required: true },
      { kind: "health", referenceId: stand.id, required: true },
    ],
    idempotencyKey: randomUUID(),
  };
  const submit = () =>
    request.post("/api/specialist-assignments", {
      data: body,
      headers: { Origin: origin },
    });
  const assignment = await read(await submit(), assignmentSchema);
  const duplicate = await read(await submit(), assignmentSchema);
  const runId = assignment.runIds[0]!;

  expect(duplicate.id).toBe(assignment.id);
  expect(duplicate.runIds).toEqual([runId]);
  const approvedStep = async () =>
    withE2EDb(async (pool) => {
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

  await expect.poll(approvedStep, { timeout: 420000 }).toBeDefined();
  const operation = (await approvedStep())!;

  await read(
    await request.post(`/api/stand-operations/${operation.id}/approval`, {
      headers: { Origin: origin },
      data: {
        expectedRevision: operation.revision,
        requestDigest: operation.request_digest,
        reason: "Authorize this exact disposable qualification restart.",
        idempotencyKey: randomUUID(),
      },
    }),
    z.object({ operationId: z.literal(operation.id) }),
  );
  await read(
    await request.post(`/api/runs/${runId}/hitl/${operation.hitl_id}/respond`, {
      data: { response: { decision: "continue" } },
    }),
    z.unknown(),
  );
  const current = () =>
    request
      .get(`/api/specialist-assignments/${assignment.id}`)
      .then((response) => read(response, assignmentSchema));

  await expect
    .poll(async () => (await current()).status, { timeout: 420000 })
    .toBe("awaiting_acceptance");
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
  const ready = await current();

  await read(
    await request.post(
      `/api/specialist-assignments/${assignment.id}/acceptance`,
      {
        data: {
          expectedRevision: ready.revision,
          inputRevision: ready.inputRevision,
          contextRevision: ready.contextRevision,
          result: { runId, revision: result.revision },
          verificationIds: result.value.verificationIds,
          reason: "Independent health and exact restart receipt verified.",
          idempotencyKey: randomUUID(),
        },
      },
    ),
    z.object({ status: z.literal("completed") }),
  );
  await page.goto(`/specialist-assignments/${assignment.id}`);
  await page
    .getByRole("button", { name: "Submit retained knowledge drafts" })
    .click();
  await page
    .getByRole("link", { name: "Open proposal 1", exact: true })
    .click();
  await expect(page.getByRole("main")).toContainText("Pending");
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
        verificationIds: result.value.verificationIds,
        acceptedChildren: execution.accepted_children,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
