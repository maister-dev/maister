import type { Db } from "@/lib/execution-host/db";
import type { PreparedSpecialistAssignment } from "@/lib/specialist-assignments/types";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { createCompanyGrants } from "@/lib/company/grants";
import { readFormSchemaDocWithBytes } from "@/lib/config";
import {
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { buildFlowExportContract } from "@/lib/run-results/contract";

const agentId = "rah:evidence-researcher";

/**
 * Installs the native RAH fixture package, grants `requesterId` the
 * assignment actions, and returns a submittable company assignment request.
 * Callers that must not write under the real home directory point `HOME` at
 * a disposable directory first; the package cache resolves through it.
 */
export async function prepareCompanySpecialistAssignment(
  db: Db,
  {
    administratorId,
    requesterId,
    version,
  }: Readonly<{
    administratorId: string;
    requesterId: string;
    version: string;
  }>,
): Promise<PreparedSpecialistAssignment> {
  const grants = await createCompanyGrants(db, administratorId, {
    principalKind: "user",
    principalId: requesterId,
    actions: [
      "assignments:read",
      "assignments:submit",
      "assignments:update",
      "assignments:cancel",
      "assignments:recover",
    ],
    idempotencyKey: randomUUID(),
  });
  const installed = await installPackageRevision({
    source: resolve("test-fixtures/rah-native"),
    version,
    db,
  });

  await trustPackageRevision({ packageInstallId: installed.id, db });
  const [pin] = (
    await db.execute(
      sql`SELECT installed_path,resolved_revision FROM package_installs WHERE id=${installed.id}`,
    )
  ).rows as { installed_path: string; resolved_revision: string }[];
  const definition = parseAgentDefinition(
    agentId,
    await readFile(
      join(pin!.installed_path, "maister-agents/evidence-researcher.md"),
      "utf8",
    ),
  );
  const [flow] = (
    await db.execute(
      sql`SELECT id,installed_path FROM flow_revisions WHERE resolved_revision=${pin!.resolved_revision} AND flow_ref_id='rah-control'`,
    )
  ).rows as { id: string; installed_path: string }[];
  const { schema, bytes } = await readFormSchemaDocWithBytes(
    flow!.installed_path,
    "./schemas/evidence-findings.v1.json",
  );
  const contract = buildFlowExportContract({
    flowRefId: "rah-control",
    resolvedRevision: pin!.resolved_revision,
    flowRevisionId: flow!.id,
    schemaPath: "./schemas/evidence-findings.v1.json",
    schema,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    required: true,
    producerNodeIds: ["research"],
    nativeContract: "evidence_findings_v1",
  });

  return {
    owner: { kind: "company", companyId: grants.page.companyId },
    specialistBindingId: randomUUID(),
    responsibleAgentId: agentId,
    objectiveInput: {
      objective: "Inspect the configured stand runbook",
      expectedOutcome: "Evidence-linked findings with explicit limitations",
      input: "No maintenance action is authorized.",
      targetIds: [],
      inputRefs: [],
      constraints: ["Research only."],
      expectedResult: {
        schemaRef: contract.schemaRef,
        schemaVersion: contract.schemaVersion,
        sha256: contract.sha256,
        required: true,
      },
      verification: [],
    },
    standingDefinition: {
      schemaVersion: 1,
      agentId,
      packageInstallId: installed.id,
      packageName: installed.name,
      packageRevision: pin!.resolved_revision,
      definitionSha256: agentDefinitionSha256(definition),
      definition,
      configuration: null,
    },
    scheduledRequest: null,
    sourceRestrictions: [],
    executionPolicy: { preset: "supervised" },
    origin: { kind: "manual", interactionId: randomUUID() },
    destination: { kind: "inbox", userId: requesterId },
  };
}
