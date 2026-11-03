import type { KnowledgeWitnessDto } from "@/lib/brain/knowledge-read-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { StartedPostgresTestDb } from "./pg-container";

import { randomUUID } from "node:crypto";

import { seedProjectRow, seedRun } from "./execution-host-seed";

import { issueAgentRunToken } from "@/lib/agents/tokens";
import { captureKnowledgeSource } from "@/lib/brain/knowledge-source-capture";
import {
  createKnowledgeProposal,
  reviewKnowledgeProposal,
} from "@/lib/brain/knowledge-proposals";

export type NativeFindingsExecution = Readonly<{
  runId: string;
  projectId: string;
  companyId: string;
  submitterId: string;
  agentId: string;
  tokenId: string;
  tokenSecret: string;
  recordId: string;
  witness: KnowledgeWitnessDto;
}>;

/** Current trusted role binding and real captured/published evidence for native result integration. */
export async function seedNativeFindingsExecution(
  database: StartedPostgresTestDb,
  contract: RunResultContract,
  agentStem: string = "researcher",
): Promise<NativeFindingsExecution> {
  const project = await seedProjectRow(database.db);
  const installationId = randomUUID();
  const packageName = `native-${installationId}`;
  const agentId = `${packageName}:${agentStem}`;
  const userId = randomUUID();
  const company = await database.pool.query<{ id: string }>(
    "SELECT id FROM companies",
  );
  const companyId = company.rows[0]!.id;

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'admin','active')",
    [userId, `${userId}@example.test`],
  );
  for (const action of [
    "knowledge:read",
    "knowledge:propose",
    "knowledge:review",
  ]) {
    await database.pool.query(
      "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'user',$2,$3,$2)",
      [companyId, userId, action],
    );
  }
  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,'github.com/fixture/native',$2,'v1.0.0','pinned-revision','{}','digest','/tmp/native-findings-role','Installed','trusted')",
    [installationId, packageName],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,$4)",
    [randomUUID(), project.id, installationId, packageName],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path) VALUES($1,$2,'v1.0.0','git','Researcher','Native findings fixture','none','session','[\"manual\"]','read_only','/tmp/native-findings-role/maister-agents/researcher.md')",
    [agentId, packageName],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,can_read_brain) VALUES($1,$2,$3,true,true)",
    [randomUUID(), project.id, agentId],
  );
  await database.pool.query(
    "INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by) VALUES($1,'agent',$2,'knowledge:read',$3)",
    [companyId, agentId, userId],
  );
  const principal = { kind: "user" as const, userId };
  const owner = { kind: "company" as const, companyId };
  const capture = await captureKnowledgeSource(database.db, principal, {
    owner,
    title: "Versioned health observation",
    content:
      "The independent health probe observed the configured component healthy.",
    idempotencyKey: `source:${installationId}`,
  });
  const proposal = await createKnowledgeProposal(database.db, {
    kind: "knowledge_add",
    owner,
    principal,
    draft: {
      title: "Health observation",
      kind: "observation",
      assertion: "The configured component was healthy at the observed time.",
      basis: "observed",
      evidence: [
        {
          relation: "supports",
          reference: { kind: "witness", id: capture.witness.id },
        },
      ],
      limitations: [
        "This observation does not prove the component's current health.",
      ],
      missingEvidence: [],
    },
    idempotencyKey: `proposal:${installationId}`,
  });

  await reviewKnowledgeProposal(database.db, {
    proposalId: proposal.id,
    principal,
    expectedRevision: proposal.revision,
    decision: "accept",
    reason:
      "Retain the attributable health observation for findings qualification.",
    idempotencyKey: `review:${installationId}`,
  });
  const published = await database.pool.query<{ published_record_id: string }>(
    "SELECT published_record_id FROM brain_proposals WHERE id=$1",
    [proposal.id],
  );
  const runId = await seedRun(database.db, {
    projectId: project.id,
    runKind: "agent",
    status: "Running",
    agentWorkspace: "none",
  });
  const snapshot = {
    version: 1,
    agentId,
    displayName: "Researcher",
    definitionSha256: "a".repeat(64),
    packageInstallId: installationId,
    packageName,
    packageVersion: "v1.0.0",
    packageRevision: "pinned-revision",
  };

  await database.pool.query(
    "UPDATE runs SET agent_id=$2,source_agent_id=$2,launched_at=now(),activity_sort_at=now(),activity_timestamp_provenance='launch',agent_activity_snapshot=$3::jsonb,result_contract=$4::jsonb,knowledge_access=$5::jsonb WHERE id=$1",
    [
      runId,
      agentId,
      JSON.stringify(snapshot),
      JSON.stringify(contract),
      JSON.stringify({
        schemaVersion: 1,
        state: "complete",
        generation: 1,
        restrictions: [],
      }),
    ],
  );
  const token = await issueAgentRunToken({
    agentId,
    projectId: project.id,
    runId,
    db: database.db,
  });

  return {
    runId,
    projectId: project.id,
    companyId,
    submitterId: userId,
    agentId,
    tokenId: token.tokenId,
    tokenSecret: token.secret,
    recordId: published.rows[0]!.published_record_id,
    witness: capture.witness,
  };
}
