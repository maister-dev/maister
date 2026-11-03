import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import {
  flows,
  flowRevisions,
  packageInstalls,
  projectPackageAttachments,
  agents,
  agentProjectLinks,
} from "@/lib/db/schema";

/** A real package-pinned cron/manual facade over an already configured immutable Flow revision. */
export async function seedTaskAgentFlowFacadeFixture(
  database: StartedPostgresTestDb,
  input: Readonly<{ root: string; projectId: string; flowId: string }>,
): Promise<
  Readonly<{ agentId: string; packageInstallId: string; installedPath: string }>
> {
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(
      and(eq(flows.id, input.flowId), eq(flows.projectId, input.projectId)),
    );
  const [revision] = flow?.enabledRevisionId
    ? await database.db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, flow.enabledRevisionId))
    : [];

  if (!flow || !revision?.resolvedRevision)
    throw new Error(
      "Facade fixture requires its actual enabled immutable Flow revision",
    );
  const packageName = `fixture-facade-${randomUUID()}`;
  const installedPath = path.join(input.root, packageName);
  const sourcePath = path.join(installedPath, "maister-agents", "facade.md");
  const packageInstallId = randomUUID();
  const agentId = `${packageName}:facade`;

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(
    sourcePath,
    `---\nname: Scheduled facade\ndescription: frozen scheduled Flow request\nkind: code_delivery\nworkspace: worktree\nmode: session\ntriggers: [manual, cron]\nrisk_tier: read_only\nflow: ${flow.flowRefId}\n---\nFollow the exact task and the recorded scheduled request.\n`,
  );
  await database.db.insert(packageInstalls).values({
    id: packageInstallId,
    sourceUrl: "local",
    name: packageName,
    versionLabel: "fixture-v1",
    resolvedRevision: revision.resolvedRevision,
    manifest: {},
    manifestDigest: "fixture",
    installedPath,
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  await database.db.insert(projectPackageAttachments).values({
    id: randomUUID(),
    projectId: input.projectId,
    packageInstallId,
    packageName,
  });
  await database.db.insert(agents).values({
    id: agentId,
    packageName,
    versionLabel: "fixture-v1",
    origin: "authored",
    name: "Scheduled facade",
    description: "frozen scheduled Flow request",
    workspace: "worktree",
    mode: "session",
    triggers: ["manual", "cron"],
    riskTier: "read_only",
    sourcePath,
    enabled: true,
  });
  await database.db
    .insert(agentProjectLinks)
    .values({ id: randomUUID(), agentId, projectId: input.projectId });

  return { agentId, packageInstallId, installedPath };
}
