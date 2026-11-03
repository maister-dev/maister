import type { RepositoryFence } from "@/lib/project-config-persistence/repository-lock";

import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";

import { withE2EDb } from "./db";
import { loadFixtures } from "./fixtures";

import { git, initRepo } from "@/test-support/git-fixture";
import { mkdtempReal } from "@/test-support/worktree-test-root";

export const MANUAL_LAUNCH_FLOW_PREFIX = "e2e-manual-launch-delivery-";
export const MANUAL_QUALIFICATION_MARKER = "E2E_MANUAL_QUALIFICATION";
export const MANUAL_REVIEW_MARKER = "E2E_TRIAGER_NEEDS_REVIEW";

export type ManualTaskLaunchFixture = Readonly<{
  projectId: string;
  slug: string;
  taskKey: string;
  root: string;
  repo: string;
  remote: string;
  flowId: string;
  flowRef: string;
  revisionId: string;
  runnerId: string;
  failedRunnerId: string;
  qualifierId: string;
}>;

/** Fresh catalog/Git data only; tasks, admission decisions and assessments use authenticated application APIs. */
export async function seedManualTaskLaunchFixture(): Promise<ManualTaskLaunchFixture> {
  const id = randomUUID();
  const projectId = randomUUID();
  const slug = `manual-launch-${id.slice(0, 8)}`;
  const root = await mkdtempReal(`${slug}-`);
  const repo = await initRepo(path.join(root, "repo"));
  const remote = path.join(root, "origin.git");
  const flowRoot = path.join(root, "flow");
  const qualifierRoot = path.join(root, "qualifier");
  const flowId = randomUUID();
  const flowRef = `${MANUAL_LAUNCH_FLOW_PREFIX}${id.slice(0, 8)}`;
  const revisionId = randomUUID();
  const runnerId = `e2e-codex-sol-${id.slice(0, 8)}`;
  const defaultRunnerId = randomUUID();
  const failedRunnerId = randomUUID();
  const qualifierName = `e2e-manual-qualifier-${id.slice(0, 8)}`;
  const qualifierId = `${qualifierName}:triager`;
  const packageId = randomUUID();
  const taskKey = `ML${id.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const manifest = {
    schemaVersion: 1,
    name: "Manual launch delivery proof",
    compat: { engine_min: "3.10.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "Implement {{ task.prompt }}" },
        transitions: { success: "review" },
        pre_finish: {
          gates: [
            {
              id: "manual-launch-proof-check",
              kind: "command_check",
              mode: "blocking",
              command:
                "test -f docs/manual-launch-proof.md && git diff --quiet && git log -1 --format=%s | grep -F 'Controlled manual launch proof'",
            },
          ],
        },
      },
      {
        id: "review",
        type: "human",
        decisions: ["approve", "rework"],
        transitions: { approve: "done", rework: "implement" },
        rework: {
          allowedTargets: ["implement"],
          workspacePolicies: ["keep"],
          maxLoops: 1,
          commentsVar: "review_comments",
        },
      },
    ],
  };

  await writeFile(
    path.join(repo, "README.md"),
    "# Controlled manual launch fixture\nInspect this tracked source before qualification.\n",
  );
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "Seed manual launch source");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-q", "origin", "main");
  await mkdir(flowRoot);
  await cp("test-support/fixtures/operational-core", qualifierRoot, {
    recursive: true,
  });
  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO platform_acp_runners(id,adapter,capability_agent,model,provider,permission_policy,readiness_status,readiness_reasons,enabled) VALUES($1,'codex','codex','gpt-6.1-sol','{\"kind\":\"openai\"}','default','Ready','[]',true),($2,'claude','claude','claude-sonnet-4-6','{\"kind\":\"anthropic\"}','default','Ready','[]',true),($3,'claude','claude','e2e-prework-unavailable','{\"kind\":\"anthropic\"}','default','Ready','[]',true)",
      [runnerId, defaultRunnerId, failedRunnerId],
    );
    await pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key,provider,repo_url,default_runner_id,task_qualification_baseline) VALUES($1,$2,'Manual launch browser fixture',$3,$4,$5,'github','https://github.com/maister-e2e/workbench-git.git',$6,'required')",
      [
        projectId,
        slug,
        repo,
        path.join(repo, "maister.yaml"),
        taskKey,
        defaultRunnerId,
      ],
    );
    await pool.query(
      "INSERT INTO project_members(id,project_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [randomUUID(), projectId, loadFixtures().users.admin.id],
    );
    await pool.query(
      "INSERT INTO flow_revisions(id,flow_ref_id,source,version_label,resolved_revision,manifest_digest,manifest,schema_version,installed_path,setup_status,package_status,exec_trust) VALUES($1,$2,'fixture','v1',$3,$4,$5,1,$6,'not_required','Installed','trusted')",
      [
        revisionId,
        flowRef,
        "a".repeat(40),
        "a".repeat(64),
        JSON.stringify(manifest),
        flowRoot,
      ],
    );
    await pool.query(
      "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version,enabled_revision_id,enablement_state,trust_status) VALUES($1,$2,$3,'fixture','v1',$4,$5,1,$6,'Enabled','trusted')",
      [
        flowId,
        projectId,
        flowRef,
        flowRoot,
        JSON.stringify(manifest),
        revisionId,
      ],
    );
    await pool.query(
      "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,$2,$3,'v1',$4,$5,'fixture',$2,'Installed','trusted')",
      [
        packageId,
        qualifierRoot,
        qualifierName,
        "b".repeat(40),
        JSON.stringify({
          spec: {
            schemaVersion: 1,
            name: qualifierName,
            flows: [],
            capabilities: [{ id: "core-bundle", path: "capability" }],
            compat: { engine_min: "3.10.0" },
          },
          inventory: {
            skills: ["task-qualification", "github-issue-intake"],
            agents: [],
            platformAgents: ["triager"],
          },
        }),
      ],
    );
    await pool.query(
      "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,$4)",
      [randomUUID(), projectId, packageId, qualifierName],
    );
    await pool.query(
      "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,workspace_ref,mode,triggers,risk_tier,source_path,kind,completion_contract,task_qualification) VALUES($1,$2,'v1','git','Controlled manual-launch Triager','Browser qualification fixture','repo_read','task_target','session','[\"manual\"]','read_only',$3,'operational','{\"contract\":\"operational_v1\"}','{\"contract\":\"v1\",\"role\":\"qualifier\"}')",
      [
        qualifierId,
        qualifierName,
        path.join(qualifierRoot, "maister-agents/triager.md"),
      ],
    );
    await pool.query(
      "INSERT INTO agent_project_links(id,project_id,agent_id,runner_override_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), projectId, qualifierId, defaultRunnerId],
    );
  });

  return {
    projectId,
    slug,
    taskKey,
    root,
    repo,
    remote,
    flowId,
    flowRef,
    revisionId,
    runnerId,
    failedRunnerId,
    qualifierId,
  };
}

/** Own the real fresh-repository fence; the test releases exactly this owner in finally. */
export async function holdManualTaskLaunchRepository(
  repo: string,
): Promise<RepositoryFence> {
  register(
    new URL("../../scripts/_server-only-shim.mjs", import.meta.url),
    import.meta.url,
  );
  const { acquireRepositoryMutationFence } =
    await import("@/lib/project-config-persistence/repository-lock");

  return acquireRepositoryMutationFence(repo);
}
