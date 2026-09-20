import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import bcrypt from "bcryptjs";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as fullSchema from "@/lib/db/schema";
import { initRepo } from "@/test-support/git-fixture";

// The relational spine the durable-worker production-boot suites launch over.
// Both suites drive the REAL web through HTTP, so everything here stops at the
// row level: no run is inserted by hand for the flow and scratch domains —
// `POST /api/runs` and `POST /api/scratch-runs` create them, which is what
// makes the evidence belong to the production launch path.
//
// The agent domain is the exception: its run row carries a result contract the
// launch route resolves from the package, so the seed writes the package and
// the catalog row and the route still creates the run.

const schema = fullSchema as unknown as Record<string, any>;

export const WORKER_ADMIN = {
  email: "durable-workers-admin@maister.local",
  password: "DurableWorkers!pass1",
};

/**
 * A prompt the mock ACP adapter answers with `text` after holding the terminal
 * response for `terminalDelayMs`. The delay is the deterministic kill window:
 * the command is `accepted` and its live waiter is in-process, so SIGKILLing
 * the web during it leaves terminal evidence that only a durable owner can
 * apply.
 */
export function fixturePrompt(spec: {
  terminalDelayMs: number;
  text?: string;
  bytes?: number;
}): string {
  return `fixture-output:${JSON.stringify({
    bytes: spec.bytes ?? 0,
    chunkSize: 400_000,
    text: spec.text ?? "",
    terminalDelayMs: spec.terminalDelayMs,
  })}`;
}

export async function seedAdmin(db: NodePgDatabase): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: WORKER_ADMIN.email,
    name: "Durable workers admin",
    passwordHash: await bcrypt.hash(WORKER_ADMIN.password, 10),
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });

  return userId;
}

export async function seedPlatformRunner(
  db: NodePgDatabase,
  options: { makeDefault?: boolean } = {},
): Promise<string> {
  const runnerId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  if (options.makeDefault !== false) {
    await db
      .insert(schema.platformRuntimeSettings)
      .values({ id: "singleton", defaultRunnerId: runnerId })
      .onConflictDoUpdate({
        target: schema.platformRuntimeSettings.id,
        set: { defaultRunnerId: runnerId },
      });
  }

  return runnerId;
}

export type SeededProject = {
  projectId: string;
  slug: string;
  repoPath: string;
};

export async function seedProjectRepo(
  db: NodePgDatabase,
  root: string,
): Promise<SeededProject> {
  const projectId = randomUUID();
  const slug = `dw-${projectId.slice(0, 8)}`;
  const repoPath = await initRepo(path.join(root, `repo-${slug}`));

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Durable workers project",
    taskKey: `DW${projectId.replaceAll("-", "").slice(0, 6)}`.toUpperCase(),
    repoPath,
    maisterYamlPath: path.join(repoPath, "maister.yaml"),
  });

  return { projectId, slug, repoPath };
}

/**
 * A one-node `ai_coding` flow plus a Backlog task, ready for `POST /api/runs`.
 * The node's prompt is the fixture spec verbatim, so the adapter's terminal
 * response is the thing the kill window straddles.
 */
export async function seedFlowTask(
  db: NodePgDatabase,
  input: {
    projectId: string;
    installedPath: string;
    terminalDelayMs: number;
  },
): Promise<{ flowId: string; taskId: string; flowRevisionId: string }> {
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const taskId = randomUUID();
  const flowRefId = `dw-${flowId.slice(0, 8)}`;
  const manifest = {
    schemaVersion: 1,
    name: "durable-workers",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "work",
        type: "ai_coding",
        action: {
          prompt: fixturePrompt({
            terminalDelayMs: input.terminalDelayMs,
            text: "\nwork node answered\n",
          }),
        },
        transitions: { success: "done" },
      },
    ],
  };

  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId,
    source: `github.com/fixture/${flowRefId}`,
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: `digest-${flowRefId}`,
    manifest,
    schemaVersion: 1,
    installedPath: input.installedPath,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId: input.projectId,
    flowRefId,
    source: `github.com/fixture/${flowRefId}`,
    version: "v1.0.0",
    installedPath: input.installedPath,
    manifest,
    schemaVersion: 1,
    enablementState: "Enabled",
    trustStatus: "trusted",
    enabledRevisionId: flowRevisionId,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    projectId: input.projectId,
    flowId,
    title: "Durable worker flow task",
    prompt: "drive the work node",
  });

  return { flowId, taskId, flowRevisionId };
}

/**
 * A package-shipped manual agent whose markdown body is the fixture prompt,
 * attached to the project — enough for
 * `POST /api/projects/{slug}/agents/{agentId}/launch`.
 */
export async function seedAgentDefinition(
  db: NodePgDatabase,
  input: {
    projectId: string;
    installedPath: string;
    terminalDelayMs: number;
  },
): Promise<{ agentId: string; packageName: string }> {
  const packageId = randomUUID();
  const packageName = `dw-pkg-${packageId.slice(0, 8)}`;
  const agentId = `${packageName}:researcher`;
  const sourcePath = path.join(
    input.installedPath,
    "maister-agents",
    "researcher.md",
  );
  const prompt = fixturePrompt({
    terminalDelayMs: input.terminalDelayMs,
    text: '\n```json maister:output\n{"summary":"durable worker answer"}\n```',
  });

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(
    sourcePath,
    [
      "---",
      "name: Researcher",
      "description: durable worker fixture",
      "workspace: none",
      "mode: session",
      "platform_mcp: false",
      "triggers:",
      "  - manual",
      "risk_tier: read_only",
      "---",
      prompt,
      "",
    ].join("\n"),
  );
  await db.insert(schema.packageInstalls).values({
    id: packageId,
    sourceUrl: `github.com/fixture/${packageName}`,
    name: packageName,
    versionLabel: "v1.0.0",
    resolvedRevision: "rev-1",
    manifest: {},
    manifestDigest: `digest-${packageName}`,
    installedPath: input.installedPath,
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  await db.insert(schema.projectPackageAttachments).values({
    id: randomUUID(),
    projectId: input.projectId,
    packageInstallId: packageId,
    packageName,
  });
  await db.insert(schema.agents).values({
    id: agentId,
    packageName,
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Researcher",
    description: "durable worker fixture",
    workspace: "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath,
    enabled: true,
  });
  await db
    .insert(schema.agentProjectLinks)
    .values({ id: randomUUID(), projectId: input.projectId, agentId });

  return { agentId, packageName };
}
