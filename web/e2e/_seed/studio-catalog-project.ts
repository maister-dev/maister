import "../../scripts/_register-shim.mjs";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify } from "yaml";

import { withE2EDb } from "./db";
import { loadFixtures } from "./fixtures";

import { closeDb } from "@/lib/db/client";
import { attachAgent } from "@/lib/agents/project-links";
import {
  attachPackage,
  installPackageRevision,
  trustPackageRevision,
} from "@/lib/packages/attach";
import { initRepo } from "@/test-support/git-fixture";
import {
  mkdtempReal,
  resolveTestWorktreesRoot,
} from "@/test-support/worktree-test-root";

type MemberFlow = Readonly<{
  id: string;
  instruction: string;
  route: string;
  agent?: string;
}>;

async function putFile(
  root: string,
  parts: readonly string[],
  contents: string,
): Promise<void> {
  const directory = join(root, ...parts.slice(0, -1));

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, parts[parts.length - 1]), contents, "utf8");
}

/** The adapter has to read the companion to know its per-invocation marker. */
async function writeSkill(
  root: string,
  slug: string,
  marker: string,
): Promise<void> {
  const dir = ["capability", "skills", slug];

  await putFile(
    root,
    [...dir, "SKILL.md"],
    `---\nname: ${slug}\ndescription: Read the delivery marker in marker.txt when asked to verify this package.\n---\nRead the adjacent marker.txt and copy its value exactly.\n`,
  );
  await putFile(root, [...dir, "marker.txt"], marker);
}

async function writeMember(root: string, flow: MemberFlow): Promise<void> {
  await putFile(
    root,
    ["flows", flow.id, "flow.yaml"],
    stringify({
      schemaVersion: 1,
      name: flow.id,
      compat: { engine_min: "3.10.0" },
      metadata: { title: flow.id, summary: flow.route, route_when: flow.route },
      nodes: [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt: flow.instruction },
          ...(flow.agent ? { settings: { agent: flow.agent } } : {}),
          transitions: { success: "done" },
        },
      ],
    }),
  );
}

export async function seedStudioCatalogProject(endpoint: string) {
  const fixtures = loadFixtures();
  const root = await mkdtempReal("studio-delivery-");
  const suffix = randomUUID().slice(0, 8);
  const projectSlug = `e2e-studio-delivery-${suffix}`;
  const project = {
    projectId: randomUUID(),
    projectSlug,
    repoPath: await initRepo(
      join(resolveTestWorktreesRoot("e2e-live", process.env), projectSlug),
    ),
    runnerId: fixtures.byKey.platformAgents.runnerId,
  };

  // Each browser scenario installs a shared package with the same skill ID.
  // A separate project keeps those providers from competing during resolution.
  await withE2EDb(async (pool) => {
    await pool.query(
      `WITH fixture AS (
         INSERT INTO projects (id, slug, name, repo_path, task_key, default_runner_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
       )
       INSERT INTO project_members (id, project_id, user_id, role)
       SELECT $7, id, $8, 'owner' FROM fixture`,
      [
        project.projectId,
        projectSlug,
        `Studio delivery ${suffix}`,
        project.repoPath,
        `SD${suffix.toUpperCase()}`,
        project.runnerId,
        randomUUID(),
        fixtures.users.admin.id,
      ],
    );
  });
  const core = `core-${suffix}`;
  const design = `design-${suffix}`;
  const dev = `dev-${suffix}`;
  const agent = `${design}:designer`;
  const coreMarker = randomUUID();
  const designMarker = randomUUID();
  const devMarker = randomUUID();
  const mcp = `design-reference-${suffix}`;
  const designFlow: MemberFlow = {
    id: `checkout-${suffix}`,
    agent,
    route: "Design a clickable checkout prototype and its customer journey.",
    instruction: `Use ask_human to ask which checkout journey to prototype. The form must contain a required string field named journey. Wait for the answer. Use the ${mcp} MCP tool read_design_reference with empty arguments to read the synthetic checkout reference. Read the design-journey skill companion. Write prototype.html with a keyboard-usable fragment link to an existing next-step element in the page, the exact human answer, the returned reference identifier and the companion marker. Complete the node.`,
  };
  const devFlow: MemberFlow = {
    id: `bugfix-${suffix}`,
    route:
      "Fix a coding regression and check the shared engineering convention.",
    instruction:
      "Read the engineering-check and core-conventions skill companions. Write their exact marker values to verification.txt on separate lines and complete the node.",
  };
  const packages = [
    {
      name: core,
      shares: true,
      member: undefined,
      skills: [["core-conventions", coreMarker]],
    },
    {
      name: design,
      shares: false,
      member: designFlow,
      skills: [
        ["design-journey", designMarker],
        ["design-unused", randomUUID()],
      ],
    },
    {
      name: dev,
      shares: false,
      member: devFlow,
      skills: [["engineering-check", devMarker]],
    },
  ];
  const installs: string[] = [];
  const members: Record<string, { taskId: string; flowId: string }> = {};
  const attachments: Record<string, { id: string; installId: string }> = {};
  const addition = "instance-reference-" + suffix;

  for (const pkg of packages) {
    const directory = join(root, pkg.name);

    for (const [slug, marker] of pkg.skills)
      await writeSkill(directory, slug, marker);
    if (pkg.member) await writeMember(directory, pkg.member);
    if (pkg.name === design) {
      await putFile(
        directory,
        ["maister-agents", "designer.md"],
        `---\nname: designer\ndescription: Design a checkout journey\nworkspace: worktree\nmode: session\ntriggers: [manual, flow]\nrisk_tier: standard\ncapability_profile:\n  skills: [design-journey]\n  mcps: [${mcp}]\n---\nUse the design-journey skill. When launched on your own, write its companion marker to designer.txt.\n`,
      );
    }
    await putFile(
      directory,
      ["maister-package.yaml"],
      stringify({
        schemaVersion: 1,
        name: pkg.name,
        delivery: { version: 1, shareSkills: pkg.shares },
        flows: pkg.member
          ? [{ id: pkg.member.id, path: `flows/${pkg.member.id}` }]
          : [],
        capabilities: [{ id: `${pkg.name}-skills`, path: "capability" }],
        ...(pkg.name === dev
          ? {
              mcps: [
                {
                  id: addition,
                  transport: "http",
                  url: endpoint,
                  scope: "package",
                },
              ],
            }
          : {}),
        ...(pkg.name === design
          ? {
              mcps: [
                { id: mcp, transport: "http", url: endpoint, scope: "package" },
              ],
            }
          : {}),
      }),
    );
    const installed = await installPackageRevision({
      source: directory,
      version: "v1.0.0",
      trustStatus: "trusted_by_policy",
    });

    installs.push(installed.id);
    const attached = await attachPackage({
      projectId: project.projectId,
      projectSlug: project.projectSlug,
      packageInstallId: installed.id,
      workspaceRoot: project.repoPath,
    });

    if (!attached) throw new Error("Fixture package did not attach");
    const trust = await trustPackageRevision({
      packageInstallId: installed.id,
    });

    if (!trust?.trusted)
      throw new Error("Fixture package revision could not be trusted");
    attachments[
      pkg.name === design ? "design" : pkg.name === dev ? "dev" : "core"
    ] = { id: attached.attachmentId, installId: installed.id };
    if (pkg.member) {
      if (!attached || attached.memberFlows.length !== 1)
        throw new Error("Fixture Flow failed to attach");
      const taskId = randomUUID();
      const member = pkg.member;

      members[pkg.name === design ? "design" : "coding"] = {
        taskId,
        flowId: attached.memberFlows[0].flowRowId,
      };
      await withE2EDb(async (pool) => {
        await pool.query(
          `INSERT INTO tasks (id,project_id,number,title,prompt,flow_id,status,stage)
           SELECT $1,$2,COALESCE(MAX(number),0)+1,$3,$4,$5,'Backlog','Backlog'
           FROM tasks WHERE project_id=$2`,
          [
            taskId,
            project.projectId,
            member.id,
            member.route,
            attached.memberFlows[0].flowRowId,
          ],
        );
      });
    }
  }
  await attachAgent({ agentId: agent, projectId: project.projectId });

  return {
    project,
    designTaskTitle: designFlow.id,
    agent,
    mcp,
    installs,
    members,
    attachments,
    addition,
    coreMarker,
    devMarker,
    designMarker,
  };
}

const endpoint = new URL(process.argv[2]);

if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.pathname !== "/mcp"
)
  throw new Error("A fixture-local MCP endpoint is required");
seedStudioCatalogProject(endpoint.href)
  .then((fixture) => {
    process.stdout.write(JSON.stringify(fixture) + "\n");
  })
  .catch((error) => {
    process.stderr.write(
      String(error instanceof Error ? error.stack : error) + "\n",
    );
    process.exitCode = 1;
  })
  .finally(closeDb);
