import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { type SessionUser } from "@/lib/authz";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { attachAgent } from "@/lib/agents/project-links";
import { loadFlowManifest, readAndValidateFormSchemaDoc } from "@/lib/config";
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
import { initRepo } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const projectId = randomUUID();
const slug = `native-rah-${projectId.slice(0, 8)}`;
const source =
  process.env.NATIVE_RAH_CANDIDATE ?? resolve("test-fixtures/rah-native");
const version = process.env.NATIVE_RAH_VERSION ?? "rah/fixture";
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
