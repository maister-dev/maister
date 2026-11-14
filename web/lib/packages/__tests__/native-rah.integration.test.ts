import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { createCompanySpecialistBinding } from "@/lib/agents/company-bindings";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { POST as bindCompanyFlow } from "@/app/api/company/flow-bindings/route";
import { requireActiveUserById, type SessionUser } from "@/lib/authz";
import {
  resolveEffectiveAgentDefinition,
  resolveInstalledAgentDefinition,
} from "@/lib/agents/effective";
import { attachAgent } from "@/lib/agents/project-links";
import { loadFlowManifest, readAndValidateFormSchemaDoc } from "@/lib/config";
import { createCompanyGrants } from "@/lib/company/grants";
import { platformAcpRunners, platformRuntimeSettings } from "@/lib/db/schema";
import {
  fakeExecutionHosts,
  scriptAgentTurn,
} from "@/test-support/fake-execution-host";
import { reserveCompanyManualAssignment } from "@/lib/specialist-assignments/company-manual-intake";
import { assertNodeLaunchable } from "@/lib/flows/enforcement";
import { deriveSessionEnforcementProfile } from "@/lib/flows/enforcement-profile";
import { enableRevision } from "@/lib/flows/lifecycle";
import { renderStrict } from "@/lib/flows/templating";
import {
  attachPackage,
  detachPackage,
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { evidenceFindingsV1Schema } from "@/lib/run-results/findings-types";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import { initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";

let database: StartedPostgresTestDb;
let root: string;
const projectId = randomUUID();
const slug = `native-rah-${projectId.slice(0, 8)}`;
const source =
  process.env.NATIVE_RAH_CANDIDATE ?? resolve("test-fixtures/rah-native");
const version = process.env.NATIVE_RAH_VERSION ?? "rah/fixture";
const standSource = process.env.STAND_PACKAGE_CANDIDATE;
const standRevision = process.env.STAND_PACKAGE_REVISION;
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => session.user,
}));

beforeAll(async () => {
  root = await mkdtemp(join(os.tmpdir(), "native-rah-install-"));
  database = await startMainPostgresTestDb({
    databaseName: "native_rah_install",
  });
  // Discover Docker against the real host first, then isolate only the package cache.
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const repository = await initRepo(join(root, "repository"));

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES($1,$2,'Native RAH qualification',$3,$4,'NRAH')",
    [projectId, slug, repository, join(repository, "maister.yaml")],
  );
}, 180000);

afterAll(async () => {
  try {
    await database?.stop();
    await rm(root, { recursive: true, force: true });
    await rm(join(process.cwd(), ".maister", slug), {
      recursive: true,
      force: true,
    });
  } finally {
    vi.restoreAllMocks();
  }
});

it("IT-CBE-04 installs exact native RAH contracts without combining install, trust, enablement or execution", async () => {
  const installed = await installPackageRevision({
    source,
    version,
    db: database.db,
  });

  expect(installed).toMatchObject({ name: "rah", reused: false });
  expect(installed.resolvedRevision).toMatch(/^[a-f0-9]{40}$/);
  expect(
    (
      await database.pool.query(
        "SELECT trust_status,package_status FROM package_installs WHERE id=$1",
        [installed.id],
      )
    ).rows,
  ).toEqual([{ trust_status: "untrusted", package_status: "Installed" }]);
  expect(
    (
      await database.pool.query("SELECT id FROM flows WHERE project_id=$1", [
        projectId,
      ])
    ).rows,
  ).toEqual([]);
  expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);
  const attached = await attachPackage({
    projectId,
    projectSlug: slug,
    packageInstallId: installed.id,
    workspaceRoot: root,
    db: database.db,
  });

  expect(attached?.memberFlows).toHaveLength(4);
  const members = await database.pool.query<{
    flow_ref_id: string;
    enabled_revision_id: string;
    enablement_state: string;
    trust_status: string;
    source: string;
  }>(
    "SELECT flow_ref_id,enabled_revision_id,enablement_state,trust_status,source FROM flows WHERE project_id=$1 ORDER BY flow_ref_id",
    [projectId],
  );

  expect(members.rows.map((row) => row.flow_ref_id)).toEqual([
    "rah-control",
    "rah-research",
    "rah-root-d1",
    "rah-root-d2",
  ]);
  for (const member of members.rows) {
    expect(member).toMatchObject({
      enablement_state: "Installed",
      trust_status: "untrusted",
    });
    await expect(
      enableRevision({
        projectId,
        flowRefId: member.flow_ref_id,
        revisionId: member.enabled_revision_id,
        db: database.db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  }
  await expect(
    resolveEffectiveAgentDefinition(
      { projectId, agentId: "rah:coordinator" },
      database.db,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await trustPackageRevision({
    packageInstallId: installed.id,
    db: database.db,
  });
  expect(
    (
      await database.pool.query(
        "SELECT DISTINCT enablement_state,trust_status FROM flows WHERE project_id=$1",
        [projectId],
      )
    ).rows,
  ).toEqual([{ enablement_state: "Installed", trust_status: "trusted" }]);

  const firstMember = members.rows[0]!;

  await database.pool.query(
    "UPDATE flows SET source=$3 WHERE project_id=$1 AND flow_ref_id=$2",
    [projectId, firstMember.flow_ref_id, firstMember.source + "-foreign"],
  );
  await expect(
    enableRevision({
      projectId,
      flowRefId: firstMember.flow_ref_id,
      revisionId: firstMember.enabled_revision_id,
      db: database.db,
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  await database.pool.query(
    "UPDATE flows SET source=$3 WHERE project_id=$1 AND flow_ref_id=$2",
    [projectId, firstMember.flow_ref_id, firstMember.source],
  );

  const schemaBytes = await readFile(
    join(source, "schemas/evidence-findings.v1.json"),
  );
  const digest = createHash("sha256").update(schemaBytes).digest("hex");
  const revisions = await database.pool.query<{
    installed_path: string;
    manifest: { result: { export: { native_contract: string } } };
    result_profiles: { findings: { nativeContract: string; sha256: string } };
  }>(
    "SELECT installed_path,manifest,result_profiles FROM flow_revisions WHERE resolved_revision=$1 ORDER BY flow_ref_id",
    [installed.resolvedRevision],
  );

  expect(revisions.rows).toHaveLength(4);
  for (const revision of revisions.rows) {
    const manifest = await loadFlowManifest(
      join(revision.installed_path, "flow.yaml"),
      {
        roleRefs: [
          "rah:coordinator",
          "rah:evidence-researcher",
          "rah:contradiction-researcher",
        ],
      },
    );

    for (const node of manifest.nodes) {
      if (node.type !== "orchestrator" && node.type !== "ai_coding") continue;
      const feedback =
        "Native findings reduction is invalid at selection[5]; preserve the exact collected finding and its evidence, limitations and questions";
      const commentsVar = node.rework?.commentsVar;

      if (!commentsVar)
        throw new Error("The native producer has no rework feedback binding");
      const initialPrompt = renderStrict(node.action.prompt, {
        task: { prompt: "Inspect the controlled corpus" },
        [commentsVar]: "",
      });
      const reworkPrompt = renderStrict(node.action.prompt, {
        task: { prompt: "Inspect the controlled corpus" },
        [commentsVar]: feedback,
      });

      expect(initialPrompt).not.toContain(feedback);
      expect(reworkPrompt).toContain(feedback);
      assertNodeLaunchable(node, "claude");
      expect(node.settings?.permissionMode).toBe("ask");
      const profile = deriveSessionEnforcementProfile({
        settings: node.settings,
        agent: "claude",
        mcpServerNames: ["maister"],
      });

      expect(profile?.tools?.allow).toEqual(
        expect.arrayContaining([
          "mcp__maister__knowledge_get",
          "mcp__maister__knowledge_evidence",
          "mcp__maister__knowledge_conflicts",
        ]),
      );
      if (["rah-root-d1", "rah-root-d2"].includes(manifest.name)) {
        expect(profile?.tools?.allow).toContain(
          "mcp__maister__knowledge_propose",
        );
        expect(profile?.tools?.allow).toContain(
          "mcp__maister__knowledge_proposal_get",
        );
      } else
        expect(profile?.tools?.allow).not.toContain(
          "mcp__maister__knowledge_propose",
        );
      for (const forbidden of [
        "Bash",
        "Write",
        "Edit",
        "mcp__maister__knowledge_confirm",
        "mcp__maister__knowledge_decide",
        "mcp__maister__knowledge_capture_source",
      ])
        expect(profile?.tools?.allow).not.toContain(forbidden);
    }
    expect(revision.manifest.result.export.native_contract).toBe(
      "evidence_findings_v1",
    );
    expect(revision.result_profiles.findings).toMatchObject({
      nativeContract: "evidence_findings_v1",
      sha256: digest,
    });
    expect(
      await readFile(
        join(revision.installed_path, "schemas/evidence-findings.v1.json"),
      ),
    ).toEqual(schemaBytes);
  }
  // The structural form accepts explicit absent proof; the native validator owns closed reference semantics.
  const schema = await readAndValidateFormSchemaDoc(
    source,
    "./schemas/evidence-findings.v1.json",
  );

  expect(schema.fields.map((field) => field.name)).toEqual([
    "schemaVersion",
    "findings",
    "knowledgeProposals",
    "selection",
  ]);
  expect(
    evidenceFindingsV1Schema.parse({
      schemaVersion: 1,
      findings: [
        {
          id: "unknown-health",
          assertion: "Current health is unknown.",
          basis: "inferred",
          supporting: [],
          contradicting: [],
          missingEvidence: [{ state: "absent", reason: "No current probe." }],
          limitations: ["No observation establishes current health."],
          openQuestions: ["What is the current state?"],
          sourceFindings: [],
        },
      ],
      knowledgeProposals: [],
      selection: [],
    }).findings[0]?.supporting,
  ).toEqual([]);
  for (const member of members.rows)
    await enableRevision({
      projectId,
      flowRefId: member.flow_ref_id,
      revisionId: member.enabled_revision_id,
      db: database.db,
    });
  expect(
    (
      await database.pool.query(
        "SELECT DISTINCT enablement_state FROM flows WHERE project_id=$1",
        [projectId],
      )
    ).rows,
  ).toEqual([{ enablement_state: "Enabled" }]);
  await attachAgent(
    { projectId, agentId: "rah:coordinator", enabled: false },
    database.db,
  );
  expect(
    (
      await database.pool.query(
        "SELECT enabled,memory_enabled FROM agent_project_links WHERE project_id=$1 AND agent_id='rah:coordinator'",
        [projectId],
      )
    ).rows,
  ).toEqual([{ enabled: false, memory_enabled: false }]);
  expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);

  expect(attached).not.toBeNull();
  await detachPackage({
    projectId,
    attachmentId: attached!.attachmentId,
    db: database.db,
  });
  await attachPackage({
    projectId,
    projectSlug: slug,
    packageInstallId: installed.id,
    workspaceRoot: root,
    db: database.db,
  });
  // A trusted cache and previous explicit enablement cannot authorize a new attachment.
  expect(
    (
      await database.pool.query(
        "SELECT DISTINCT enablement_state,trust_status FROM flows WHERE project_id=$1",
        [projectId],
      )
    ).rows,
  ).toEqual([{ enablement_state: "Installed", trust_status: "trusted" }]);
  expect((await database.pool.query("SELECT id FROM runs")).rows).toEqual([]);
});

it.skipIf(!standSource || !standRevision)(
  "installs the real pinned stand Flow with its required operational evidence export",
  async () => {
    const installed = await installPackageRevision({
      source: standSource!,
      version: "stand-operations/v0.1.0",
      path: "packages/stand-operations",
      db: database.db,
    });

    expect(installed).toMatchObject({
      name: "stand-operations",
      resolvedRevision: standRevision,
    });
    await trustPackageRevision({
      packageInstallId: installed.id,
      db: database.db,
    });
    for (const role of ["coordinator", "diagnostic", "inspector"]) {
      const definition = await resolveInstalledAgentDefinition(database.db, {
        agentId: `stand-operations:${role}`,
        packageInstallId: installed.id,
      });

      expect(definition.parsed.specialist?.targetClasses).toEqual(["stand"]);
      expect(definition.parsed.workspace).toBe("none");
      expect(definition.parsed.flow).toBe(
        role === "coordinator" ? "stand-maintenance" : null,
      );
      if (role === "inspector") {
        expect(definition.parsed.triggers).toEqual(["cron"]);
        expect(definition.parsed.riskTier).toBe("read_only");
      }
      if (role !== "coordinator") {
        expect(buildOperationalContract(definition)).toMatchObject({
          kind: "agent_operational",
          contractName: "operational_evidence_v2",
          semanticVersion: 2,
          required: true,
        });
      }
    }
    const {
      rows: [flow],
    } = await database.pool.query<{
      id: string;
      installed_path: string;
      resolved_revision: string;
      manifest: unknown;
      manifest_digest: string;
    }>(
      "SELECT id,installed_path,resolved_revision,manifest,manifest_digest FROM flow_revisions WHERE flow_ref_id='stand-maintenance' AND resolved_revision=$1",
      [standRevision],
    );

    expect(flow).toBeDefined();
    const contract = await resolveFlowExportContract({
      flowRefId: "stand-maintenance",
      manifest: flow!.manifest,
      revision: {
        id: flow!.id,
        installedPath: flow!.installed_path,
        resolvedRevision: flow!.resolved_revision,
      },
    });

    expect(contract).toMatchObject({
      kind: "flow_export",
      nativeContract: "operational_evidence_v2",
      schemaVersion: 2,
      required: true,
      producerNodeIds: ["execute", "declined"],
    });
    const reviewerId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
      [reviewerId, `${reviewerId}@example.test`],
    );
    const grant = await createCompanyGrants(database.db, reviewerId, {
      principalKind: "user",
      principalId: reviewerId,
      actions: [
        "specialists:read",
        "specialists:manage",
        "assignments:answer",
        "assignments:read",
        "assignments:submit",
        "assignments:update",
      ],
      idempotencyKey: randomUUID(),
    });
    const definition = await resolveInstalledAgentDefinition(database.db, {
      agentId: "stand-operations:coordinator",
      packageInstallId: installed.id,
    });
    const runnerId = randomUUID();

    await database.db.insert(platformAcpRunners).values({
      id: runnerId,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "installed-stand-contract-fixture",
      provider: { kind: "anthropic" },
      readinessStatus: "Ready",
    });
    await database.db
      .insert(platformRuntimeSettings)
      .values({ id: "singleton", defaultRunnerId: runnerId })
      .onConflictDoUpdate({
        target: platformRuntimeSettings.id,
        set: { defaultRunnerId: runnerId },
      });
    const { specialist } = await createCompanySpecialistBinding(
      database.db,
      reviewerId,
      definition.parsed.id,
      {
        owner: { kind: "company", companyId: grant.page.companyId },
        packageInstallId: installed.id,
        packageRevision: installed.resolvedRevision,
        definitionSha256: agentDefinitionSha256(definition.parsed),
        coordinatorFlowRevisionId: flow!.id,
        runnerId,
        configuration: {},
        grantActions: ["assignments:read", "targets:read"],
        enabled: true,
        idempotencyKey: randomUUID(),
      },
    );

    const review = {
      owner: specialist.owner,
      specialistBindingId: specialist.bindingId,
      specialistRevision: specialist.configRevision,
      flowRevisionId: flow!.id,
      manifestSha256: flow!.manifest_digest,
      execution: { workspace: "none", completion: "result" },
      enabled: true,
      roleMappings: { operator: [reviewerId] },
      idempotencyKey: randomUUID(),
    };

    session.user = await requireActiveUserById(reviewerId);
    const bind = (origin: string) =>
      bindCompanyFlow(
        new NextRequest("http://localhost/api/company/flow-bindings", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify(review),
        }),
      );

    expect((await bind("https://different-origin.test")).status).toBe(403);
    const bound = await bind("http://localhost");

    expect(bound.status).toBe(201);
    const receipt = await bound.json();
    const replay = await bind("http://localhost");

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(receipt).toMatchObject({
      owner: specialist.owner,
      enabled: true,
      revision: 1,
    });
    session.user = null;
    const { hosts, fake } = await fakeExecutionHosts(database.db);
    const smoke = {
      status: "ok" as const,
      reason: null,
      checkedAt: new Date().toISOString(),
      protocolVersion: 1,
    };

    fake.setDiagnostics({
      kind: "ready",
      diagnostics: {
        status: "ready",
        version: "fixture",
        checkedAt: smoke.checkedAt,
        envRefs: [],
        adapters: [
          {
            id: "claude",
            binary: "fixture-claude",
            source: "path",
            path: null,
            available: true,
            version: null,
            error: null,
            smoke: {
              ...smoke,
              capabilityEnforcement: smoke,
              readOnlySession: { ...smoke, probeVersion: 2, staleReason: null },
            },
          },
        ],
      },
    });
    const { assignment } = await reserveCompanyManualAssignment(
      database.db,
      reviewerId,
      {
        owner: specialist.owner,
        specialistBindingId: specialist.bindingId,
        objective: "Inspect the configured component.",
        expectedOutcome: "Evidence or a request for clarification.",
        input: "",
        targetIds: [],
        inputRefs: [],
        constraints: [],
        verification: [{ kind: "result", required: true, referenceId: null }],
        idempotencyKey: randomUUID(),
      },
      hosts,
    );

    expect(assignment.runIds).toHaveLength(1);
    expect(
      (
        await database.pool.query(
          "SELECT project_id,task_id,company_id,result_contract->>'nativeContract' AS contract FROM runs WHERE id=$1",
          [assignment.runIds[0]],
        )
      ).rows,
    ).toEqual([
      {
        project_id: null,
        task_id: null,
        company_id: grant.page.companyId,
        contract: "operational_evidence_v2",
      },
    ]);
    const runId = assignment.runIds[0]!;
    const operationId = randomUUID();
    const { prompts } = scriptAgentTurn(fake, {
      text:
        "```json maister:output\n" +
        JSON.stringify({ operationId }) +
        "\n```\n",
    });

    await expect(
      tryStartRun(runId, { db: database.db }),
    ).resolves.toMatchObject({ started: true });
    await runFlow(runId, {
      db: database.db,
      executionHosts: hosts,
      runtimeRoot: root,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(assignment.id);
    expect(
      (
        await database.pool.query(
          "SELECT status,current_step_id FROM runs WHERE id=$1",
          [runId],
        )
      ).rows,
    ).toEqual([{ status: "NeedsInput", current_step_id: "authorize" }]);
    expect(
      (
        await database.pool.query(
          "SELECT step_id,kind FROM hitl_requests WHERE run_id=$1 AND responded_at IS NULL",
          [runId],
        )
      ).rows,
    ).toEqual([{ step_id: "authorize", kind: "human" }]);

    const { submitProjectManualAssignment } =
      await import("@/lib/specialist-assignments/project-manual-intake");
    await attachPackage({
      projectId,
      projectSlug: slug,
      packageInstallId: installed.id,
      workspaceRoot: root,
      db: database.db,
    });
    await enableRevision({
      projectId,
      flowRefId: "stand-maintenance",
      revisionId: flow!.id,
      db: database.db,
    });
    const projectRole = await attachAgent(
      {
        projectId,
        agentId: definition.parsed.id,
        runnerOverrideId: runnerId,
        enabled: true,
      },
      database.db,
    );
    const projectWork = {
      owner: { kind: "project" as const, projectId },
      specialistBindingId: projectRole.linkId,
      objective: "Inspect a project-owned stand assignment.",
      expectedOutcome:
        "Retain the package's exact operational result contract.",
      input:
        "Ask for clarification if an operator has not appointed a component.",
      targetIds: [],
      inputRefs: [],
      constraints: [],
      verification: [{ kind: "result", required: true, referenceId: null }],
      idempotencyKey: randomUUID(),
    };
    const { interactiveTaskLaunchPrincipal } =
      await import("@/lib/tasks/admission-types");
    const { prepareTaskLaunchIntent } =
      await import("@/lib/tasks/launch-dispatch");
    session.user = await requireActiveUserById(reviewerId);
    const principal = await interactiveTaskLaunchPrincipal();
    const projectReceipt = await submitProjectManualAssignment(
      database.db,
      reviewerId,
      projectWork,
      principal,
    );
    expect(projectReceipt.projectAdmission?.kind).toBe("accepted");
    if (projectReceipt.projectAdmission?.kind !== "accepted")
      throw new Error(
        "The live project package did not enter the native admission queue",
      );
    const intentId = projectReceipt.projectAdmission.receipt.intentId;
    const projectPlacement = await prepareTaskLaunchIntent(
      database.db,
      intentId,
    );
    expect(projectPlacement.state).toBe("run_bound");
    const projectRunId = projectPlacement.runId;
    session.user = null;

    expect(projectRunId).toBeDefined();
    expect(
      (
        await database.pool.query(
          "SELECT project_id,company_id,result_contract->>'nativeContract' AS contract FROM runs WHERE id=$1",
          [projectRunId],
        )
      ).rows,
    ).toEqual([
      {
        project_id: projectId,
        company_id: null,
        contract: "operational_evidence_v2",
      },
    ]);
    const originalIntentKey = projectReceipt.projectAdmission.receipt.intentId;
    expect(
      (
        await database.pool.query(
          "SELECT id FROM task_launch_intents WHERE project_id=$1 AND settings_snapshot->'serverExecution'->'execution'->'specialistAssignment'->>'assignmentId'=$2",
          [projectId, projectReceipt.assignment.id],
        )
      ).rows,
    ).toEqual([{ id: originalIntentKey }]);

    const path = (
      await database.pool.query<{ worktree_path: string | null }>(
        "SELECT worktree_path FROM workspaces WHERE run_id=$1",
        [projectRunId],
      )
    ).rows[0]?.worktree_path;
    if (path) {
      const { removeWorktree } = await import("@/lib/worktree");
      await removeWorktree({
        projectRepoPath: join(root, "repository"),
        worktreePath: path,
        force: true,
      });
    }
  },
);
