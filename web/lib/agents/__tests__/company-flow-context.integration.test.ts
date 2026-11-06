import type { CompanyFlowContextInput } from "../company-flow-context";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { PreparedSpecialistAssignment } from "@/lib/specialist-assignments/types";

import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { agentDefinitionSha256 } from "../activity-snapshot";
import { createCompanySpecialistBinding } from "../company-bindings";
import {
  createCompanyFlowBinding,
  getCompanyFlowBinding,
} from "../company-flow-bindings";
import {
  captureCompanyFlowExecution,
  prepareCompanyFlowContext,
} from "../company-flow-context";
import { updateCompanyFlowBinding } from "../company-flow-binding-mutations";
import { parseAgentDefinition } from "../definition";

import { createSpecialistAssignment } from "@/lib/specialist-assignments/store";
import { createCompanyGrants, revokeCompanyGrant } from "@/lib/company/grants";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { resolveFlowExportContract } from "@/lib/run-results/flow-export";
import * as engine from "@/lib/flows/engine-version";
import { git, initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let schemaPath: string;
let request: CompanyFlowContextInput;
const administratorId = randomUUID();
const requesterId = randomUUID();
const outsiderId = randomUUID();
const result = {
  schema: "./schemas/evidence-findings.v1.json",
  required: true,
};
const manifest = {
  schemaVersion: 1,
  name: "rah-control",
  compat: { engine_min: "3.12.0", engine_max: "3.12.0" },
  execution: { workspace: "none", completion: "result" },
  result: {
    export: {
      ...result,
      native_contract: "evidence_findings_v1",
      from: ["diagnose"],
    },
  },
  nodes: [
    {
      id: "diagnose",
      type: "ai_coding",
      action: {
        prompt:
          "Investigate {{ assignment.objective }} using {{ assignment.input }}.",
      },
      output: { result },
      transitions: { success: "done" },
    },
  ],
};

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

function useEngineVersion(version: string) {
  return vi
    .spyOn(engine, "isEngineCompatible")
    .mockImplementation((min, max) => {
      const compatible =
        (min === undefined || engine.semverGte(version, min)) &&
        (max === undefined || engine.semverGte(max, version));

      return {
        compatible,
        reason: compatible
          ? null
          : "Controlled host is outside the declared engine range",
      };
    });
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "company_flow_context",
  });
  root = await mkdtemp(join(os.tmpdir(), "company-flow-context-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active'),($3,$4,'member','active'),($5,$6,'member','active')",
    [
      administratorId,
      `${administratorId}@example.test`,
      requesterId,
      `${requesterId}@example.test`,
      outsiderId,
      `${outsiderId}@example.test`,
    ],
  );
  const grant = await createCompanyGrants(database.db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: [
      "specialists:read",
      "specialists:manage",
      "assignments:read",
      "assignments:submit",
      "assignments:update",
    ],
    idempotencyKey: randomUUID(),
  });
  const source = join(root, "source");

  await cp(resolve("test-fixtures/rah-native"), source, {
    recursive: true,
    filter: (path) => !path.split(sep).includes(".git"),
  });
  const rolePath = join(source, "maister-agents/evidence-researcher.md");

  await writeFile(
    rolePath,
    (await readFile(rolePath, "utf8")).replace(
      "workspace: none",
      "specialist:\n  responsibilities: [Coordinate authorized diagnosis]\n  targetClasses: [stand]\nflow: rah-control\nworkspace: none",
    ),
  );
  await writeFile(
    join(source, "flows/rah-control/flow.yaml"),
    stringify(manifest),
  );
  await initRepo(source);
  await git(
    source,
    "tag",
    "-a",
    "rah/company-context-v1",
    "-m",
    "Controlled company coordinator preflight fixture",
  );
  const installed = await installPackageRevision({
    source,
    version: "rah/company-context-v1",
    db: database.db,
  });

  await trustPackageRevision({
    packageInstallId: installed.id,
    db: database.db,
  });
  const pin = (
    await database.pool.query<{
      installed_path: string;
      resolved_revision: string;
      name: string;
    }>(
      "SELECT installed_path,resolved_revision,name FROM package_installs WHERE id=$1",
      [installed.id],
    )
  ).rows[0]!;
  const definition = parseAgentDefinition(
    "rah:evidence-researcher",
    await readFile(
      join(pin.installed_path, "maister-agents/evidence-researcher.md"),
      "utf8",
    ),
  );
  const flow = (
    await database.pool.query<{
      id: string;
      manifest_digest: string;
      installed_path: string;
    }>(
      "SELECT id,manifest_digest,installed_path FROM flow_revisions WHERE flow_ref_id='rah-control' AND resolved_revision=$1",
      [pin.resolved_revision],
    )
  ).rows[0]!;
  const specialist = await createCompanySpecialistBinding(
    database.db,
    requesterId,
    definition.id,
    {
      owner: { kind: "company", companyId: grant.page.companyId },
      packageInstallId: installed.id,
      packageRevision: pin.resolved_revision,
      definitionSha256: agentDefinitionSha256(definition),
      coordinatorFlowRevisionId: flow.id,
      configuration: {},
      grantActions: [],
      enabled: true,
      idempotencyKey: randomUUID(),
    },
  );
  // Only the pure compatibility predicate is simulated for this future-capability
  // configuration fixture. The real engine remains 3.11.1 and is tested below.
  const compatibility = useEngineVersion("3.12.0");
  let coordinator: Awaited<ReturnType<typeof createCompanyFlowBinding>>;

  try {
    coordinator = await createCompanyFlowBinding(database.db, requesterId, {
      owner: specialist.specialist.owner,
      specialistBindingId: specialist.specialist.bindingId,
      specialistRevision: specialist.specialist.configRevision,
      flowRevisionId: flow.id,
      manifestSha256: flow.manifest_digest,
      execution: { workspace: "none", completion: "result" },
      enabled: true,
      roleMappings: {},
      idempotencyKey: randomUUID(),
    });
  } finally {
    compatibility.mockRestore();
  }
  const contract = await resolveFlowExportContract({
    flowRefId: "rah-control",
    manifest,
    revision: {
      id: flow.id,
      installedPath: flow.installed_path,
      resolvedRevision: pin.resolved_revision,
    },
  });

  if (!contract)
    throw new Error("The real installed coordinator result schema is missing");
  const input: PreparedSpecialistAssignment = {
    owner: specialist.specialist.owner,
    specialistBindingId: specialist.specialist.bindingId,
    responsibleAgentId: definition.id,
    objectiveInput: {
      objective: "Diagnose configured stand",
      expectedOutcome: "Evidence-linked diagnosis",
      input: "Inspect only",
      targetIds: ["stand:configured"],
      inputRefs: [],
      constraints: ["No unapproved restart"],
      expectedResult: {
        schemaRef: contract.schemaRef,
        schemaVersion: contract.schemaVersion,
        sha256: contract.sha256,
        required: true,
      },
      verification: [{ kind: "result", referenceId: null, required: true }],
    },
    standingDefinition: {
      schemaVersion: 1,
      agentId: definition.id,
      packageInstallId: installed.id,
      packageName: pin.name,
      packageRevision: pin.resolved_revision,
      definitionSha256: agentDefinitionSha256(definition),
      definition,
      configuration: {},
    },
    sourceRestrictions: [],
    scheduledRequest: null,
    executionPolicy: specialist.specialist.executionPolicy,
    origin: { kind: "manual", interactionId: randomUUID() },
    destination: { kind: "inbox", userId: requesterId },
  };
  const assignment = await createSpecialistAssignment(
    database.db,
    requesterId,
    input,
  );

  schemaPath = join(flow.installed_path, "schemas/evidence-findings.v1.json");
  request = {
    companyId: grant.page.companyId,
    assignmentId: assignment.id,
    assignmentRevision: assignment.revision,
    inputRevision: assignment.inputRevision,
    bindingId: specialist.specialist.bindingId,
    bindingRevision: specialist.specialist.configRevision,
    coordinatorBindingId: coordinator.binding.id,
    coordinatorBindingRevision: coordinator.binding.revision,
    triggerSource: "manual",
  };
}, 180000);

afterAll(async () => {
  try {
    await database?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
  }
});

type AllocationCounts = Readonly<{
  projects: number;
  tasks: number;
  runs: number;
  sessions: number;
  links: number;
}>;

async function counts(): Promise<AllocationCounts> {
  return (
    await database.pool.query<AllocationCounts>(
      "SELECT (SELECT count(*)::int FROM projects) AS projects,(SELECT count(*)::int FROM tasks) AS tasks,(SELECT count(*)::int FROM runs) AS runs,(SELECT count(*)::int FROM run_sessions) AS sessions,(SELECT count(*)::int FROM specialist_run_links) AS links",
    )
  ).rows[0]!;
}

it("refuses the actual unsupported host capability before allocating any repository or execution", async () => {
  expect(engine.MAISTER_ENGINE_VERSION).toBe("3.11.1");
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, request),
    ),
  ).rejects.toMatchObject({
    code: "CONFIG",
    details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
  });
  expect(await counts()).toEqual({
    projects: 0,
    tasks: 0,
    runs: 0,
    sessions: 0,
    links: 0,
  });
});

it("prepares exact trusted installed graph/input/result witnesses on a supported host without creating a carrier Task", async () => {
  const compatibility = useEngineVersion("3.12.0");

  try {
    const context = await database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, request),
    );
    const snapshot = captureCompanyFlowExecution(context);

    expect(context).toMatchObject({
      owner: { kind: "company", companyId: request.companyId },
      assignment: { id: request.assignmentId },
      resultContract: { kind: "flow_export", required: true },
    });
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      executionKind: "flow",
      assignment: {
        id: request.assignmentId,
        inputRevision: request.inputRevision,
      },
      specialistBinding: {
        id: request.bindingId,
        revision: request.bindingRevision,
      },
      coordinatorFlowBinding: {
        id: request.coordinatorBindingId,
        revision: request.coordinatorBindingRevision,
      },
      authority: { actor: { id: requesterId } },
    });
    expect(context.resultContract.flowRevisionId).toBe(
      context.coordinator.snapshot.flowRevisionId,
    );
    expect(snapshot).not.toHaveProperty("projectId");
    expect(await counts()).toEqual({
      projects: 0,
      tasks: 0,
      runs: 0,
      sessions: 0,
      links: 0,
    });
  } finally {
    compatibility.mockRestore();
  }
});

it.each([
  { assignmentRevision: 2 },
  { inputRevision: 2 },
  { bindingRevision: 2 },
  { coordinatorBindingRevision: 2 },
])(
  "refuses a stale reviewed business/input/configuration revision: %j",
  async (change) => {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, { ...request, ...change }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  },
);

it("requires current initiating authority even when the caller knows the exact owned configuration", async () => {
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, outsiderId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

it("refuses changed required schema bytes under the same retained package identity", async () => {
  const original = await readFile(schemaPath, "utf8");
  const compatibility = useEngineVersion("3.12.0");

  try {
    await writeFile(schemaPath, original + "\n");
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, request),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "company_assignment_result_mismatch" },
    });
  } finally {
    await writeFile(schemaPath, original);
    compatibility.mockRestore();
  }
});

it("honors the pinned Flow maximum on a newer host before execution allocation", async () => {
  const compatibility = useEngineVersion("3.13.0");

  try {
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, request),
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
    });
    expect(await counts()).toEqual({
      projects: 0,
      tasks: 0,
      runs: 0,
      sessions: 0,
      links: 0,
    });
  } finally {
    compatibility.mockRestore();
  }
});

it("refuses disabled coordinator configuration and requires the new reviewed revision when re-enabled", async () => {
  const current = await getCompanyFlowBinding(
    database.db,
    requesterId,
    request.coordinatorBindingId,
  );
  const configuration = current.configuration;
  const replacement = {
    owner: current.owner,
    specialistBindingId: configuration.specialistBindingId,
    specialistRevision: configuration.specialistRevision,
    flowRevisionId: configuration.flowRevisionId,
    manifestSha256: configuration.manifestSha256,
    execution: configuration.execution,
    roleMappings: configuration.roleMappings,
  };
  const disabled = await updateCompanyFlowBinding(
    database.db,
    requesterId,
    current.id,
    {
      ...replacement,
      enabled: false,
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    },
  );

  request = {
    ...request,
    coordinatorBindingRevision: disabled.binding.revision,
  };
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, request),
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "company_flow_binding_disabled" },
  });
  await expect(
    updateCompanyFlowBinding(database.db, requesterId, current.id, {
      ...replacement,
      enabled: true,
      expectedRevision: disabled.binding.revision,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({
    code: "CONFIG",
    details: { flowManifestIncompatibility: { kind: "engine_incompatible" } },
  });
  expect(
    (await getCompanyFlowBinding(database.db, requesterId, current.id))
      .revision,
  ).toBe(disabled.binding.revision);
  const compatibility = useEngineVersion("3.12.0");

  try {
    const enabled = await updateCompanyFlowBinding(
      database.db,
      requesterId,
      current.id,
      {
        ...replacement,
        enabled: true,
        expectedRevision: disabled.binding.revision,
        idempotencyKey: randomUUID(),
      },
    );
    const stale = request;

    request = {
      ...request,
      coordinatorBindingRevision: enabled.binding.revision,
    };
    await expect(
      database.db.transaction((tx) =>
        prepareCompanyFlowContext(tx, requesterId, stale),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await database.db.transaction((tx) =>
          prepareCompanyFlowContext(tx, requesterId, request),
        )
      ).coordinator.revision,
    ).toBe(enabled.binding.revision);
  } finally {
    compatibility.mockRestore();
  }
});

it("uses current initiating authority after revocation rather than the frozen input witness", async () => {
  const grant = (
    await database.pool.query<{ id: string; revision: number }>(
      "SELECT id,revision FROM company_grants WHERE principal_type='user' AND principal_id=$1 AND action='assignments:update' AND revoked_at IS NULL",
      [requesterId],
    )
  ).rows[0]!;

  await revokeCompanyGrant(database.db, administratorId, grant.id, {
    expectedRevision: grant.revision,
    reason: "Revoke coordinator admission",
    idempotencyKey: randomUUID(),
  });
  await expect(
    database.db.transaction((tx) =>
      prepareCompanyFlowContext(tx, requesterId, request),
    ),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(await counts()).toEqual({
    projects: 0,
    tasks: 0,
    runs: 0,
    sessions: 0,
    links: 0,
  });
});
