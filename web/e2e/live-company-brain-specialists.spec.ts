import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { KnowledgeDraft } from "@/lib/brain/knowledge-types";
import type { KnowledgeProposalInput } from "@/lib/brain/knowledge-write-types";
import type { EvidenceFindingsV1 } from "@/lib/run-results/findings-types";

import { randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadNativeCompanyBrainFixtures } from "./_seed/native-company-brain-fixtures";
import { waitForTaskLaunchRun } from "./_seed/task-launch";
import {
  captureNativeQualificationDiagnostics,
  qualificationSecretValues,
} from "./_seed/native-qualification-diagnostics";

import { resolveTestWorktreesRoot } from "@/test-support/worktree-test-root";
import {
  knowledgeRecordEvidenceSchema,
  knowledgeRecordSchema,
  knowledgeWitnessSchema,
} from "@/lib/brain/knowledge-read-types";
import {
  knowledgeMutationReceiptSchema,
  knowledgeProposalContentSchema,
} from "@/lib/brain/knowledge-write-types";
import { evidenceFindingsV1Schema } from "@/lib/run-results/findings-types";

const idSchema = z.object({ id: z.string().min(1) });
const enforcementSchema = z.object({
  tools: z.object({ allow: z.array(z.string()) }),
  enforcedClasses: z.array(z.string()),
});
const roles = [
  "rah:coordinator",
  "rah:evidence-researcher",
  "rah:contradiction-researcher",
] as const;
const proofSchema = z.object({
  runId: z.string(),
  parentRunId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  kind: z.enum(["flow", "agent"]),
  status: z.string(),
  revision: z.number().int().positive(),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  collectedAt: z.string().nullable(),
  sessionIds: z.array(z.string().min(1)).min(1),
  value: evidenceFindingsV1Schema,
});

type RunProof = z.infer<typeof proofSchema>;
type RunDiagnostic = Readonly<{
  runId: string;
  parentRunId: string | null;
  status: string;
  validity: string | null;
  invalidReason: string | null;
  promptHasNativeGrammar: boolean;
}>;

const runtimeModelWitnessSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  runnerId: z.string().nullable(),
  configuredModel: z.string().nullable(),
  observedModels: z.array(z.string()),
});

/** Meter model IDs come from host usage events, independently of the configured runner snapshot. */
async function inspectRuntimeModels(
  rootIds: readonly string[],
): Promise<Array<z.infer<typeof runtimeModelWitnessSchema>>> {
  return withE2EDb(async (pool) => {
    const rows = await pool.query(
      `WITH RECURSIVE tree AS (
        SELECT id,0 AS depth FROM runs WHERE id=ANY($1::text[])
        UNION ALL SELECT r.id,t.depth+1 FROM runs r JOIN tree t ON r.parent_run_id=t.id WHERE t.depth<3
      ) SELECT DISTINCT t.id AS "runId",s.acp_session_id AS "sessionId",s.runner_id AS "runnerId",
        s.runner_snapshot->>'model' AS "configuredModel",
        ARRAY(SELECT DISTINCT e.payload->>'model' FROM execution_events e
          WHERE e.run_id=t.id AND e.source='host' AND e.event_type='usage.recorded'
            AND EXISTS (SELECT 1 FROM run_session_incarnations i
              WHERE i.run_session_id=s.id AND i.run_id=t.id
                AND i.execution_host_id=e.execution_host_id
                AND i.host_session_id=e.host_session_id)
            AND jsonb_typeof(e.payload->'model')='string'
          ORDER BY e.payload->>'model') AS "observedModels"
      FROM tree t JOIN run_sessions s ON s.run_id=t.id WHERE s.acp_session_id IS NOT NULL
      ORDER BY t.id,s.acp_session_id`,
      [rootIds],
    );

    return z.array(runtimeModelWitnessSchema).parse(rows.rows);
  });
}

async function assertRuntimeModels(
  rootId: string,
  tree: readonly RunProof[],
  runner: Readonly<{ id: string; model: string }>,
): Promise<void> {
  const witnesses = await inspectRuntimeModels([rootId]);

  expect(witnesses).toHaveLength(
    tree.reduce((count, run) => count + run.sessionIds.length, 0),
  );
  for (const witness of witnesses) {
    expect(witness.runnerId).toBe(runner.id);
    expect(witness.configuredModel).toBe(runner.model);
    expect(
      witness.observedModels,
      `Run ${witness.runId} session ${witness.sessionId} must retain actual host usage for the requested model`,
    ).toEqual([runner.model]);
  }
}

function requiredSetting(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Live qualification requires ${name}`);

  return value;
}

async function readResponse<T>(
  response: APIResponse,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = await response.text();

  expect(
    response.ok(),
    `HTTP ${response.status()}: ${body.slice(0, 4000)}`,
  ).toBe(true);

  const parsed = schema.safeParse(JSON.parse(body));

  if (!parsed.success)
    throw new Error(
      `Unexpected HTTP ${response.status()} response: ${body.slice(0, 4000)}`,
      { cause: parsed.error },
    );

  return parsed.data;
}

async function acceptProposal(
  request: APIRequestContext,
  content: KnowledgeProposalInput["content"],
): Promise<z.infer<typeof knowledgeRecordSchema>> {
  const submitted = await readResponse(
    await request.post("/api/knowledge/proposals", {
      data: { content, idempotencyKey: randomUUID() },
    }),
    knowledgeMutationReceiptSchema,
  );

  await readResponse(
    await request.post(`/api/knowledge/proposals/${submitted.id}/decision`, {
      data: {
        expectedRevision: submitted.revision,
        decision: "accept",
        reason:
          "Controlled live qualification corpus, without fact confirmation.",
        idempotencyKey: randomUUID(),
      },
    }),
    knowledgeMutationReceiptSchema,
  );
  const proposal = await readResponse(
    await request.get(`/api/knowledge/proposals/${submitted.id}`),
    z.object({
      status: z.literal("accepted"),
      acceptedRecordId: z.string().min(1),
    }),
  );

  return readResponse(
    await request.get(`/api/knowledge/${proposal.acceptedRecordId}`),
    knowledgeRecordSchema,
  );
}

async function launchResearchTask(
  request: APIRequestContext,
  origin: string,
  selection: Readonly<{ taskId: string; flowId: string; runnerId: string }>,
): Promise<{ runId: string }> {
  const options = await readResponse(
    await request.get("/api/task-launch-intents/options", {
      params: selection,
    }),
    z.object({ taskRevision: z.number().int(), settingsToken: z.string() }),
  );
  const receipt = await readResponse(
    await request.post("/api/task-launch-intents", {
      headers: { Origin: origin, "Idempotency-Key": randomUUID() },
      data: {
        ...selection,
        expectedTaskRevision: options.taskRevision,
        expectedSettingsToken: options.settingsToken,
        autoPromote: false,
      },
    }),
    z.object({
      schemaVersion: z.literal(1),
      intentId: z.string().min(1),
      taskId: z.literal(selection.taskId),
    }),
  );

  return { runId: await waitForTaskLaunchRun(receipt) };
}

async function inspectTree(rootId: string): Promise<RunProof[]> {
  return withE2EDb(async (pool) => {
    const rows = await pool.query(
      `WITH RECURSIVE tree AS (
        SELECT id,parent_run_id,run_kind,status,0 AS depth FROM runs WHERE id=$1
        UNION ALL
        SELECT r.id,r.parent_run_id,r.run_kind,r.status,t.depth+1
          FROM runs r JOIN tree t ON r.parent_run_id=t.id WHERE t.depth<3
      ) SELECT t.id AS "runId",t.parent_run_id AS "parentRunId",t.depth,t.run_kind AS kind,t.status,
        rr.revision,rr.schema_sha256 AS "schemaSha256",rr.engine_version AS "engineVersion",rr.first_collected_at::text AS "collectedAt",rr.value,
        ARRAY(SELECT s.acp_session_id FROM run_sessions s WHERE s.run_id=t.id AND s.acp_session_id IS NOT NULL) AS "sessionIds"
      FROM tree t LEFT JOIN run_results rr ON rr.run_id=t.id AND rr.validity='valid'
      ORDER BY t.depth,t.id`,
      [rootId],
    );

    const states = z
      .array(z.object({ runId: z.string(), status: z.string() }))
      .parse(rows.rows);

    expect(
      states.filter((run) => run.status !== "Done" && run.status !== "Review"),
      "Every required child must complete with a valid result before this scenario qualifies",
    ).toEqual([]);

    return z.array(proofSchema).parse(rows.rows);
  });
}

function references(value: EvidenceFindingsV1): Set<string> {
  return new Set(
    value.findings
      .flatMap((finding) => [...finding.supporting, ...finding.contradicting])
      .map((reference) => reference.id),
  );
}

test("QL-CBX-03 the real pinned RAH package retrieves structured company knowledge and preserves original evidence through depth two", async ({
  request,
  page,
  context,
  baseURL,
}, testInfo) => {
  test.setTimeout(3300000);
  if (!baseURL) throw new Error("Live qualification requires a browser origin");
  const origin = new URL(baseURL).origin;

  expect(requiredSetting("E2E_LIVE_SUPERVISOR")).toBe("1");
  const sourceUrl = requiredSetting("E2E_RAH_GIT_URL");
  const tag = requiredSetting("E2E_RAH_TAG");
  const expectedCommit = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(requiredSetting("E2E_RAH_COMMIT"));
  const runnerInput: unknown = JSON.parse(
    await readFile(requiredSetting("E2E_LIVE_RUNNER_CONFIG"), "utf8"),
  );
  const runner = z
    .object({
      id: z.string().min(1),
      adapter: z.literal("claude"),
      model: z.string().min(1),
      permissionPolicy: z.literal("default"),
    })
    .parse(runnerInput);
  const fixture = loadNativeCompanyBrainFixtures();
  const project = fixture.byKey.scratch;

  expect(
    await singleValue<string>("SELECT current_database() AS value", []),
  ).toBe("maister_e2e");
  expect(
    await singleValue<number>("SELECT count(*)::int AS value FROM runs", []),
  ).toBe(0);
  expect(
    await singleValue<number>(
      "SELECT count(*)::int AS value FROM brain_items",
      [],
    ),
  ).toBe(0);
  expect(
    await singleValue<number>(
      "SELECT count(*)::int AS value FROM brain_sources",
      [],
    ),
  ).toBe(0);
  expect(await realpath(project.repoPath)).toBe(
    await realpath(
      path.join(
        resolveTestWorktreesRoot("e2e-live", process.env),
        "fixtures",
        "repos",
        "e2e-acceptance-scratch",
      ),
    ),
  );
  expect(await readFile(path.join(project.repoPath, "README.md"), "utf8")).toBe(
    "base\n",
  );

  const runIds: string[] = [];
  const browserRuns: Array<{ flowId: string; runId: string }> = [];
  const proofs: RunProof[][] = [];
  const enforcementProofs: Array<{
    runId: string;
    profile: z.infer<typeof enforcementSchema>;
  }> = [];
  const nativeProposalIds = new Set<string>();
  const controlAgentId = "rah:evidence-researcher";
  let controlReadGrant: { id: string; revision: number } | null = null;
  const dependencies = z
    .object({
      dependencies: z.object({
        "@agentclientprotocol/claude-agent-acp": z.string(),
      }),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../supervisor/package.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const diagnostics = await readResponse(
    await request.get(
      `http://127.0.0.1:${process.env.MAISTER_SUPERVISOR_PORT ?? "7777"}/diagnostics`,
    ),
    z.object({
      adapters: z.array(
        z.object({
          id: z.string(),
          version: z.string().nullable(),
          path: z.string().nullable(),
          available: z.boolean(),
          smoke: z.object({
            capabilityEnforcement: z.object({ status: z.string() }).optional(),
          }),
        }),
      ),
    }),
  );
  const adapter = diagnostics.adapters.find(
    (item) => item.id === runner.adapter,
  );

  expect(adapter?.available).toBe(true);
  if (!adapter?.path)
    throw new Error("The real Claude adapter executable is unavailable");
  const installedAdapter = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(
        await readFile(
          new URL(
            "../../supervisor/node_modules/@agentclientprotocol/claude-agent-acp/package.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );

  expect(installedAdapter.version).toBe(
    dependencies.dependencies["@agentclientprotocol/claude-agent-acp"],
  );
  expect(await realpath(adapter.path)).toBe(
    await realpath(
      new URL(
        "../../supervisor/node_modules/.bin/claude-agent-acp",
        import.meta.url,
      ),
    ),
  );
  expect(adapter?.smoke.capabilityEnforcement?.status).toBe("ok");

  try {
    await readResponse(
      await request.post("/api/admin/acp-runners", { data: runnerInput }),
      z.object({ ok: z.literal(true), id: z.literal(runner.id) }),
    );
    expect(
      await singleValue<string>(
        "SELECT readiness_status AS value FROM platform_acp_runners WHERE id=$1",
        [runner.id],
      ),
    ).toBe("Ready");
    const source = await readResponse(
      await request.post("/api/admin/package-sources", {
        data: { url: sourceUrl, kind: "git" },
      }),
      idSchema,
    );
    const installed = await readResponse(
      await request.post("/api/admin/package-installs", {
        data: { sourceId: source.id, name: "rah", version: tag },
      }),
      idSchema,
    );

    expect(
      await singleValue<string>(
        "SELECT resolved_revision AS value FROM package_installs WHERE id=$1",
        [installed.id],
      ),
    ).toBe(expectedCommit);
    await readResponse(
      await request.post(`/api/admin/package-installs/${installed.id}/trust`),
      z.object({ ok: z.literal(true) }),
    );
    await readResponse(
      await request.post(`/api/projects/${project.projectSlug}/packages`, {
        data: { packageInstallId: installed.id },
      }),
      z.object({ ok: z.literal(true) }),
    );
    const flows = await withE2EDb(async (pool) => {
      const result = await pool.query(
        "SELECT flow_ref_id AS id,enabled_revision_id AS revision FROM flows WHERE project_id=$1 AND flow_ref_id LIKE 'rah-%' ORDER BY flow_ref_id",
        [project.projectId],
      );

      return z
        .array(z.object({ id: z.string(), revision: z.string() }))
        .parse(result.rows);
    });

    expect(flows.map((flow) => flow.id)).toEqual([
      "rah-control",
      "rah-research",
      "rah-root-d1",
      "rah-root-d2",
    ]);
    expect(
      await singleValue<string>(
        "SELECT node->'settings'->>'agent' AS value FROM flow_revisions f CROSS JOIN LATERAL jsonb_array_elements(f.manifest->'nodes') node WHERE f.id=$1 AND node->>'id'='research'",
        [flows.find((flow) => flow.id === "rah-control")?.revision],
      ),
      "The revoked grant must belong to the installed control Flow's executing role",
    ).toBe(controlAgentId);
    for (const flow of flows) {
      await readResponse(
        await request.patch(
          `/api/projects/${project.projectSlug}/flow-runner-remaps`,
          {
            data: {
              flowRevisionId: flow.revision,
              slotKey: "session:research",
              mappedRunnerId: runner.id,
            },
          },
        ),
        z.object({
          remap: z.object({
            flowRevisionId: z.literal(flow.revision),
            slotKey: z.literal("session:research"),
            mappedRunnerId: z.literal(runner.id),
            status: z.literal("Mapped"),
          }),
        }),
      );
      await readResponse(
        await request.post(
          `/api/projects/${project.projectSlug}/flow-packages/${flow.id}/enable`,
          { data: { revisionId: flow.revision } },
        ),
        z.object({ ok: z.literal(true) }),
      );
    }
    for (const agentId of roles) {
      await readResponse(
        await request.post(`/api/projects/${project.projectSlug}/agents`, {
          data: { agentId, enabled: true, runnerOverrideId: runner.id },
        }),
        z.object({ ok: z.literal(true) }),
      );
      await readResponse(
        await request.patch(
          `/api/projects/${project.projectSlug}/agents/${encodeURIComponent(agentId)}`,
          { data: { canReadBrain: true, memoryEnabled: false } },
        ),
        z.object({ ok: z.literal(true) }),
      );
      const granted = await readResponse(
        await request.post("/api/company/grants", {
          data: {
            principalKind: "agent",
            principalId: agentId,
            actions:
              agentId === "rah:coordinator"
                ? ["knowledge:read", "knowledge:propose"]
                : ["knowledge:read"],
            idempotencyKey: randomUUID(),
          },
        }),
        z.object({
          companyId: z.string(),
          items: z.array(
            z.object({
              id: z.string(),
              action: z.string(),
              revision: z.number().int().positive(),
            }),
          ),
        }),
      );

      if (agentId === controlAgentId) {
        const readGrant = granted.items.find(
          (item) => item.action === "knowledge:read",
        );

        if (!readGrant)
          throw new Error("Control researcher read grant was not retained");
        controlReadGrant = readGrant;
      }
    }
    const grant = await readResponse(
      await request.post("/api/company/grants", {
        data: {
          principalKind: "user",
          principalId: fixture.users.admin.id,
          actions: ["knowledge:read", "knowledge:propose", "knowledge:review"],
          idempotencyKey: randomUUID(),
        },
      }),
      z.object({ companyId: z.string() }),
    );
    const owner = { kind: "company" as const, companyId: grant.companyId };
    const witness = await readResponse(
      await request.post("/api/knowledge/sources", {
        data: {
          owner,
          title: "Controlled qualification runbook",
          content:
            "This is a synthetic research corpus, not an authorized maintenance target. The current runbook requires a separate post-restart health check. An older contradictory note claims that a restart alone is sufficient. No current service observation is available.",
          reportedSourceVersion: "qualification-corpus-v1",
          idempotencyKey: randomUUID(),
        },
      }),
      knowledgeWitnessSchema,
    );
    const draft: KnowledgeDraft = {
      title: "Qualification runbook assertion",
      kind: "procedure",
      assertion:
        "The current runbook requires an independent health check after restart.",
      basis: "observed",
      evidence: [
        {
          relation: "supports",
          reference: {
            kind: "witness",
            id: witness.id,
            version: witness.sourceVersion ?? undefined,
            sha256: witness.sha256 ?? undefined,
          },
        },
      ],
      missingEvidence: [],
      limitations: [
        "Synthetic research corpus; no real service health is established.",
      ],
    };
    const original = await acceptProposal(request, {
      ...draft,
      change: "add",
      owner,
    });
    const dependent = await acceptProposal(request, {
      ...draft,
      change: "add",
      owner,
      title: "Older interpretation",
      assertion:
        "The first recorded runbook assertion was used as an interpretation.",
      basis: "inferred",
      evidence: [
        {
          relation: "derived_from",
          reference: {
            kind: "knowledge",
            id: original.id,
            revision: original.revision,
          },
        },
      ],
    });
    const current = await acceptProposal(request, {
      ...draft,
      change: "correct",
      recordId: original.id,
      expectedRevision: original.revision,
      assertion:
        "The current runbook requires an independent post-action health check; process exit alone is insufficient.",
    });
    const opposing = await acceptProposal(request, {
      ...draft,
      change: "add",
      owner,
      title: "Opposing historical note",
      assertion:
        "The older note claims restart completion alone establishes health; this conflicts with the current runbook.",
      evidence: [
        ...draft.evidence,
        {
          relation: "contradicts",
          reference: {
            kind: "knowledge",
            id: current.id,
            revision: current.revision,
          },
        },
      ],
    });
    const conflict = await readResponse(
      await request.get(`/api/knowledge/${current.id}`),
      knowledgeRecordSchema,
    );

    expect(conflict.conflict.state).toBe("unresolved");
    expect(conflict.conflict.accessibleRecordIds).toContain(opposing.id);
    const staleEvidence = await readResponse(
      await request.get(`/api/knowledge/${dependent.id}/evidence`),
      z
        .object({
          items: z.array(knowledgeRecordEvidenceSchema),
        })
        .passthrough(),
    );

    expect(
      staleEvidence.items.some(
        (item) => "witness" in item && item.witness.availability === "stale",
      ),
    ).toBe(true);
    const prompt = `Research only this controlled corpus with owner ${JSON.stringify(owner)}. Retrieve current record ${current.id}, opposing record ${opposing.id}, and dependent record ${dependent.id}, including their evidence and conflict views. The dependent record refers to an older revision and must be described as stale where reported. Preserve the unresolved opposing claim. Current real service health is missing: report explicit missing evidence and an unresolved question. Repeated citations of witness ${witness.id} are one source, never independent confirmation. Produce nonempty findings with original evidence references and a reviewable knowledge proposal grounded only in the findings. The root coordinator has an explicit company knowledge:propose grant: after collection submit one evidence-linked proposal through knowledge_propose, with a stable request idempotency key, and also include its content in knowledgeProposals. Subordinate roles have read grants only. Do not confirm facts or perform any maintenance action.`;

    for (const flowId of ["rah-root-d1", "rah-root-d2"]) {
      const task = await readResponse(
        await request.post(`/api/projects/${project.projectSlug}/tasks`, {
          data: { title: `Live native ${flowId}`, prompt, flowId },
        }),
        z.object({ taskId: z.string() }),
      );
      const launched = await launchResearchTask(request, origin, {
        taskId: task.taskId,
        flowId,
        runnerId: runner.id,
      });

      runIds.push(launched.runId);
      const enforcementQuery =
        "SELECT (create_intent->>'requestCanonicalJson')::jsonb->'payload'->'enforcementProfile' AS value FROM execution_commands WHERE run_id=$1 AND kind='session.create' LIMIT 1";

      await expect
        .poll(() => singleValue<unknown>(enforcementQuery, [launched.runId]), {
          timeout: 60000,
          intervals: [100, 500, 1000],
        })
        .toMatchObject({
          enforcedClasses: expect.arrayContaining(["tools"]),
          tools: {
            allow: expect.arrayContaining([
              "mcp__maister__knowledge_get",
              "mcp__maister__knowledge_propose",
            ]),
          },
        });
      const effectiveEnforcement = enforcementSchema.parse(
        await singleValue<unknown>(enforcementQuery, [launched.runId]),
      );

      for (const name of [
        "Bash",
        "Write",
        "Edit",
        "mcp__maister__knowledge_confirm",
        "mcp__maister__knowledge_decide",
      ])
        expect(effectiveEnforcement.tools.allow).not.toContain(name);
      enforcementProofs.push({
        runId: launched.runId,
        profile: effectiveEnforcement,
      });
      await expect
        .poll(
          () =>
            singleValue<string>(
              "SELECT status AS value FROM runs WHERE id=$1",
              [launched.runId],
            ),
          { timeout: 1200000, intervals: [1000, 2000, 5000] },
        )
        .toMatch(
          /^(Done|Review|Failed|Crashed|Abandoned|NeedsInput|NeedsInputIdle)$/,
        );
      expect(
        await singleValue<string>(
          "SELECT status AS value FROM runs WHERE id=$1",
          [launched.runId],
        ),
        "A governed refusal or pending HITL does not qualify completion",
      ).toMatch(/^(Done|Review)$/);
      const tree = await inspectTree(launched.runId);

      await assertRuntimeModels(launched.runId, tree, runner);

      expect(
        tree.every((run) => run.status === "Done" || run.status === "Review"),
        JSON.stringify(tree.map(({ runId, status }) => ({ runId, status }))),
      ).toBe(true);
      expect(Math.max(...tree.map((run) => run.depth))).toBe(
        flowId === "rah-root-d2" ? 2 : 1,
      );
      expect(tree.every((run) => run.value.findings.length > 0)).toBe(true);
      expect(
        tree.every((run) =>
          run.sessionIds.every((id) => !/^(compat-|fake|stub)/.test(id)),
        ),
      ).toBe(true);
      const root = tree.find((run) => run.runId === launched.runId);

      expect(root).toBeDefined();
      if (!root) throw new Error("Actual root result is missing");
      expect(references(root.value).has(witness.id)).toBe(true);
      expect(
        tree.filter(
          (run) =>
            run.kind === "agent" && references(run.value).has(witness.id),
        ).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        root.value.findings.some((finding) => finding.contradicting.length > 0),
      ).toBe(true);
      expect(
        root.value.findings.some(
          (finding) => finding.missingEvidence.length > 0,
        ),
      ).toBe(true);
      expect(root.value.knowledgeProposals.length).toBeGreaterThan(0);
      for (const run of tree) {
        const children = tree.filter(
          (child) => child.parentRunId === run.runId,
        );

        for (const child of children) {
          expect(child.collectedAt).not.toBeNull();
          for (const finding of child.value.findings)
            expect(run.value.selection).toContainEqual(
              expect.objectContaining({
                childRunId: child.runId,
                resultRevision: child.revision,
                findingId: finding.id,
              }),
            );
        }
        const retained = await readResponse(
          await request.get(`/api/runs/${run.runId}/results/${run.revision}`),
          z.object({
            validity: z.literal("valid"),
            findings: evidenceFindingsV1Schema,
            schemaSha256: z.string(),
          }),
        );

        expect(retained.findings).toEqual(run.value);
        expect(retained.schemaSha256).toBe(run.schemaSha256);
      }
      proofs.push(tree);
      const proposalId = await singleValue<string>(
        "SELECT s.proposal_id AS value FROM brain_knowledge_submissions s JOIN brain_proposals p ON p.id=s.proposal_id WHERE s.attribution->>'runId'=$1 AND p.kind IN ('knowledge_add','knowledge_correct') ORDER BY s.received_at LIMIT 1",
        [launched.runId],
      );

      expect(
        proposalId,
        "The actual coordinator must submit attributable write-back, not only describe it in its result",
      ).not.toBeNull();
      if (!proposalId)
        throw new Error("No coordinator write-back receipt exists");
      nativeProposalIds.add(proposalId);
      const proposed = await readResponse(
        await request.get(`/api/knowledge/proposals/${proposalId}`),
        z.object({
          status: z.literal("pending"),
          content: knowledgeProposalContentSchema,
          attribution: z.object({
            kind: z.literal("agent"),
            id: z.literal("rah:coordinator"),
            runId: z.string(),
            attemptId: z.string(),
          }),
        }),
      );

      expect(runIds).toContain(proposed.attribution.runId);
      const resultProposal = root.value.knowledgeProposals.find(
        (content) =>
          content.assertion === proposed.content.assertion &&
          content.title === proposed.content.title,
      );

      expect(
        resultProposal,
        "Published findings must carry the actual submitted proposal content",
      ).toBeDefined();
      if (!resultProposal)
        throw new Error("Submitted proposal is absent from the actual result");
      const { evidence, missingEvidence, limitations, ...submittedFields } =
        proposed.content;
      const {
        evidence: resultEvidence,
        missingEvidence: resultMissing,
        limitations: resultLimits,
        ...resultFields
      } = resultProposal;

      expect(resultFields).toEqual(submittedFields);
      // The native submission service deduplicates and orders these sets.
      for (const [submitted, returned] of [
        [evidence, resultEvidence],
        [missingEvidence, resultMissing],
        [limitations, resultLimits],
      ] as const) {
        expect(submitted).toEqual(expect.arrayContaining(returned));
        expect(returned).toEqual(expect.arrayContaining(submitted));
      }
      browserRuns.push({ flowId, runId: launched.runId });
    }
    for (const recordId of [current.id, dependent.id, opposing.id]) {
      const record = await readResponse(
        await request.get(`/api/knowledge/${recordId}`),
        knowledgeRecordSchema,
      );

      expect(record.owner).toEqual(owner);
      expect(record.confirmation.state).toBe("unconfirmed");
      expect(record.attribution).toMatchObject({
        kind: "user",
        id: fixture.users.admin.id,
      });
    }
    const proposalId = [...nativeProposalIds][0];

    if (!proposalId)
      throw new Error("No native proposal is available for human review");
    const pending = await readResponse(
      await request.get(`/api/knowledge/proposals/${proposalId}`),
      z.object({ revision: z.number().int().positive() }),
    );

    await readResponse(
      await request.post(`/api/knowledge/proposals/${proposalId}/decision`, {
        data: {
          expectedRevision: pending.revision,
          decision: "accept",
          reason:
            "Human review of the actual coordinator's controlled-corpus findings; no fact confirmation.",
          idempotencyKey: randomUUID(),
        },
      }),
      knowledgeMutationReceiptSchema,
    );
    const accepted = await readResponse(
      await request.get(`/api/knowledge/proposals/${proposalId}`),
      z.object({ acceptedRecordId: z.string().min(1) }),
    );
    const written = await readResponse(
      await request.get(`/api/knowledge/${accepted.acceptedRecordId}`),
      knowledgeRecordSchema,
    );

    expect(written.confirmation.state).toBe("unconfirmed");
    expect(written.attribution).toMatchObject({
      kind: "agent",
      id: "rah:coordinator",
    });
    if (!controlReadGrant)
      throw new Error(
        "No control researcher read grant is available to revoke",
      );
    await readResponse(
      await request.delete(`/api/company/grants/${controlReadGrant.id}`, {
        data: {
          expectedRevision: controlReadGrant.revision,
          reason: "Controlled live current-authority refusal check.",
          idempotencyKey: randomUUID(),
        },
      }),
      z.object({ id: z.string() }),
    );
    expect(
      await singleValue<number>(
        "SELECT count(*)::int AS value FROM company_grants WHERE company_id=$1 AND principal_type='agent' AND principal_id=$2 AND action='knowledge:read' AND revoked_at IS NULL",
        [owner.companyId, controlAgentId],
      ),
    ).toBe(0);
    const unavailableTask = await readResponse(
      await request.post(`/api/projects/${project.projectSlug}/tasks`, {
        data: {
          title: "Live unavailable knowledge references",
          flowId: "rah-control",
          prompt: `Using only knowledge tools, inspect owner ${JSON.stringify(owner)} records ${current.id} and ${randomUUID()}. Do not guess or repeat their contents. A missing or inaccessible reference requires explicit missingEvidence, limitations and an unresolved question, with empty supporting/contradicting references. No delegation, proposals or maintenance actions.`,
        },
      }),
      z.object({ taskId: z.string() }),
    );
    const unavailableRun = await launchResearchTask(request, origin, {
      taskId: unavailableTask.taskId,
      flowId: "rah-control",
      runnerId: runner.id,
    });

    runIds.push(unavailableRun.runId);
    await expect
      .poll(
        () =>
          singleValue<string>("SELECT status AS value FROM runs WHERE id=$1", [
            unavailableRun.runId,
          ]),
        { timeout: 600000, intervals: [1000, 2000, 5000] },
      )
      .toMatch(
        /^(Done|Review|Failed|Crashed|Abandoned|NeedsInput|NeedsInputIdle)$/,
      );
    const unavailable = await inspectTree(unavailableRun.runId);

    await assertRuntimeModels(unavailableRun.runId, unavailable, runner);

    proofs.push(unavailable);
    expect(unavailable).toHaveLength(1);
    expect(
      await singleValue<string>(
        "SELECT knowledge_actor->>'agentId' AS value FROM node_attempts WHERE run_id=$1 AND node_id='research' ORDER BY attempt DESC LIMIT 1",
        [unavailableRun.runId],
      ),
    ).toBe(controlAgentId);
    expect(
      unavailable[0]?.value.findings.some(
        (finding) =>
          finding.missingEvidence.length > 0 &&
          finding.limitations.length > 0 &&
          finding.openQuestions.length > 0,
      ),
    ).toBe(true);
    expect(
      unavailable[0]?.value.findings.every(
        (finding) =>
          finding.supporting.length === 0 && finding.contradicting.length === 0,
      ),
    ).toBe(true);
    for (const { flowId, runId } of browserRuns) {
      const shell = page.getByTestId("run-shell").filter({ visible: true });
      const findingsPanel = shell
        .getByTestId("run-shell-inspector")
        .getByTestId("native-findings");

      for (const locale of ["en", "ru"] as const) {
        await context.addCookies([
          {
            name: "NEXT_LOCALE",
            value: locale,
            url: origin,
          },
        ]);
        await page.goto(`/runs/${runId}?inspector=open`);
        await expect(findingsPanel).toHaveCount(1);
        await expect(findingsPanel).toBeVisible();
        await expect(
          findingsPanel.getByRole("heading", {
            name:
              locale === "en"
                ? "Evidence-linked findings"
                : "Выводы со ссылками на доказательства",
            exact: true,
            level: 3,
          }),
        ).toBeVisible();
        await expect(
          findingsPanel
            .locator(`a[href="/knowledge/witnesses/${witness.id}"]`)
            .first(),
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`${flowId}-${locale}.png`),
          fullPage: true,
          caret: "initial",
        });
      }
    }
  } finally {
    const runtimeModelWitnesses = await inspectRuntimeModels(runIds);
    const ledgerDiagnostics = await withE2EDb(async (pool) => {
      const result = await pool.query<RunDiagnostic>(
        `WITH RECURSIVE tree AS (
          SELECT id,parent_run_id,status,0 AS depth FROM runs WHERE id=ANY($1::text[])
          UNION ALL SELECT r.id,r.parent_run_id,r.status,t.depth+1 FROM runs r JOIN tree t ON r.parent_run_id=t.id WHERE t.depth<3
        ) SELECT t.id AS "runId",t.parent_run_id AS "parentRunId",t.status,rr.validity,rr.invalid_reason AS "invalidReason",
          EXISTS(SELECT 1 FROM execution_commands c WHERE c.run_id=t.id AND c.kind='session.prompt'
            AND c.request_canonical_json LIKE '%Native result JSON Schema:%') AS "promptHasNativeGrammar"
          FROM tree t LEFT JOIN run_results rr ON rr.run_id=t.id ORDER BY t.depth,t.id,rr.revision`,
        [runIds],
      );

      return result.rows;
    });
    const executionDiagnostics = await withE2EDb((pool) =>
      captureNativeQualificationDiagnostics(pool, runIds, {
        projectId: project.projectId,
        repoPath: project.repoPath,
        hostPaths: [
          process.cwd(),
          resolveTestWorktreesRoot("e2e-live", process.env),
          ...(process.env.MAISTER_RUNTIME_ROOT
            ? [process.env.MAISTER_RUNTIME_ROOT]
            : []),
        ],
        secretValues: qualificationSecretValues(process.env),
      }),
    );

    const evidencePath = testInfo.outputPath(
      "native-package-qualification.json",
    );

    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          sourceUrl,
          tag,
          expectedCommit,
          runner,
          adapter,
          runIds,
          proofs,
          enforcementProofs,
          dataClassification:
            "generated synthetic corpus in a fresh owned database and temporary repository; no existing Brain or private repository input",
          nativeProposalIds: [...nativeProposalIds],
          ledgerDiagnostics,
          executionDiagnostics,
          runtimeModelWitnesses,
        },
        null,
        2,
      ),
      "utf8",
    );
    await testInfo.attach("native-package-qualification.json", {
      path: evidencePath,
      contentType: "application/json",
    });
  }
});
