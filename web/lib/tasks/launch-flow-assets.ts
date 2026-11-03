import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run, taskLaunchIntents } from "@/lib/db/schema";
import type { TaskLaunchFlowPreparationIdentity } from "./launch-types";

import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { captureAcceptedDirectory } from "./launch-capability-materialization";
import { assertManagedCapturePath } from "./launch-capture-path";

import {
  projects,
  flowRevisions,
  taskLaunchIntents as intents,
} from "@/lib/db/schema";
import { atomicWriteJson } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";
import { localDirectoryContentDigest } from "@/lib/flows";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { runtimeRoot } from "@/lib/runtime-root";

export type TaskLaunchFlowAssetsSnapshot = Readonly<{
  version: 1;
  flowRevisionId: string;
  manifestDigest: string;
  contentDigest: string;
}>;

const witnessSchema = z
  .object({
    version: z.literal(1),
    intentId: z.string(),
    runId: z.string(),
    incarnationId: z.string(),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function assetsChanged(cause?: unknown): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The accepted Flow assets cannot be reproduced; inspect its installation and launch again",
    {
      details: {
        reason: "launch_flow_assets_changed",
        stage: "flow_asset_capture",
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);

    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

/** Filesystem capture identities are resolved in preview/preflight, outside SQL transactions. */
export async function captureTaskLaunchFlowAssets(
  db: Db,
  selection: Readonly<{ flowRevisionId: string }>,
): Promise<TaskLaunchFlowAssetsSnapshot> {
  const [revision] = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, selection.flowRevisionId));

  if (!revision) throw assetsChanged();

  return {
    version: 1,
    flowRevisionId: revision.id,
    manifestDigest: revision.manifestDigest,
    contentDigest: await localDirectoryContentDigest(revision.installedPath),
  };
}

type FlowIntent = typeof taskLaunchIntents.$inferSelect;

async function assetPaths(
  db: Db,
  intent: FlowIntent,
  identity: TaskLaunchFlowPreparationIdentity,
): Promise<
  Readonly<{ root: string; directory: string; assets: string; witness: string }>
> {
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, intent.projectId));

  if (
    !project ||
    !/^[A-Za-z0-9_-]+$/.test(project.slug) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(identity.runId)
  )
    throw assetsChanged();
  const root = await realpath(runtimeRoot());
  const directory = runDirPath(root, project.slug, identity.runId);

  return {
    root,
    directory,
    assets: path.join(directory, "accepted-flow"),
    witness: path.join(directory, "accepted-flow.json"),
  };
}

async function assertManagedAssetPaths(
  paths: Readonly<{ root: string; assets: string; witness: string }>,
): Promise<void> {
  try {
    await assertManagedCapturePath(paths.assets);
    await assertManagedCapturePath(paths.witness);
  } catch (error) {
    throw assetsChanged(error);
  }
}

function frozenAssets(intent: FlowIntent): TaskLaunchFlowAssetsSnapshot {
  const settings = intent.settingsSnapshot;

  if (
    settings.kind !== "flow" ||
    settings.version !== 2 ||
    !settings.flowAssets ||
    settings.flowAssets.flowRevisionId !== settings.flowRevisionId
  )
    throw assetsChanged();

  return settings.flowAssets;
}

async function assertCaptureOwner(
  db: Db,
  intent: FlowIntent,
  identity: TaskLaunchFlowPreparationIdentity,
): Promise<void> {
  const [owner] = await db
    .select({ id: intents.id })
    .from(intents)
    .where(
      and(
        eq(intents.id, intent.id),
        eq(intents.state, "preparing"),
        sql`${intents.leaseToken}=${intent.leaseToken}`,
        sql`${intents.leaseExpiresAt}>clock_timestamp()`,
        sql`${intents.preparationIdentity}->>'incarnationId'=${identity.incarnationId}`,
        isNull(intents.dispatchCommittedAt),
      ),
    );

  if (!owner)
    throw new MaisterError(
      "CONFLICT",
      "Flow asset preparation no longer owns its launch",
      { details: { reason: "launch_worker_fenced" } },
    );
}

async function verifyCapturedAssets(
  db: Db,
  intent: FlowIntent,
  identity: TaskLaunchFlowPreparationIdentity,
): Promise<string> {
  const expected = frozenAssets(intent);
  const paths = await assetPaths(db, intent, identity);

  await assertManagedAssetPaths(paths);
  await assertAssetWitness(intent, identity, paths.witness);
  if (
    (await localDirectoryContentDigest(paths.assets)) !== expected.contentDigest
  )
    throw assetsChanged();

  return paths.assets;
}

async function assertAssetWitness(
  intent: FlowIntent,
  identity: TaskLaunchFlowPreparationIdentity,
  file: string,
): Promise<void> {
  const expected = frozenAssets(intent);
  let witness: z.infer<typeof witnessSchema>;

  try {
    witness = witnessSchema.parse(
      JSON.parse(await readFile(file, "utf8")) as unknown,
    );
  } catch (error) {
    throw assetsChanged(error);
  }
  if (
    witness.intentId !== intent.id ||
    witness.runId !== identity.runId ||
    witness.incarnationId !== identity.incarnationId ||
    witness.settingsDigest !== intent.settingsDigest ||
    witness.contentDigest !== expected.contentDigest
  )
    throw assetsChanged();
}

/** Closed, never-bound preparations share the checkout cleanup owner; a bound Run retains its assets. */
export async function removeTaskLaunchFlowAssets(
  db: Db,
  intent: FlowIntent,
  identity: TaskLaunchFlowPreparationIdentity,
): Promise<void> {
  const [owner] = await db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.id, intent.id),
        eq(intents.cleanupState, "pending"),
        isNull(intents.runId),
        isNull(intents.originalRunId),
        isNull(intents.dispatchCommittedAt),
        sql`${intents.state} IN ('held','failed','cancelled','settled')`,
        sql`NOT EXISTS(SELECT 1 FROM runs linked WHERE linked.id=${identity.runId} OR linked.task_launch_intent_id=${intents.id})`,
      ),
    );

  if (
    !owner ||
    owner.preparationIdentity?.incarnationId !== identity.incarnationId ||
    owner.settingsDigest !== intent.settingsDigest
  )
    throw assetsChanged();
  const paths = await assetPaths(db, owner, identity);

  await assertManagedAssetPaths(paths);
  const presentAssets = await exists(paths.assets);
  const presentWitness = await exists(paths.witness);

  if (!presentAssets && !presentWitness) return;
  await assertAssetWitness(owner, identity, paths.witness);
  if (presentAssets) {
    await verifyCapturedAssets(db, owner, identity);
    await rm(paths.assets, { recursive: true });
  }
  await rm(paths.witness);
}

/** Called only by the preparation owner; partial captures are retained and refused, never silently overwritten. */
export async function prepareTaskLaunchFlowAssets(
  db: Db,
  intent: FlowIntent,
  identity: TaskLaunchFlowPreparationIdentity,
): Promise<string> {
  await assertCaptureOwner(db, intent, identity);
  const expected = frozenAssets(intent);
  const [revision] = await db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, expected.flowRevisionId));

  if (!revision || revision.manifestDigest !== expected.manifestDigest)
    throw assetsChanged();
  await mkdir(runtimeRoot(), { recursive: true });
  const paths = await assetPaths(db, intent, identity);

  await assertManagedAssetPaths(paths);
  await mkdir(paths.directory, { recursive: true });
  await assertManagedAssetPaths(paths);
  if ((await exists(paths.assets)) || (await exists(paths.witness)))
    return verifyCapturedAssets(db, intent, identity);
  try {
    await captureAcceptedDirectory(
      revision.installedPath,
      paths.assets,
      expected.contentDigest,
    );
  } catch (error) {
    throw assetsChanged(error);
  }
  await assertCaptureOwner(db, intent, identity);
  await assertManagedAssetPaths(paths);
  await atomicWriteJson(paths.witness, {
    version: 1,
    intentId: intent.id,
    runId: identity.runId,
    incarnationId: identity.incarnationId,
    settingsDigest: intent.settingsDigest,
    contentDigest: expected.contentDigest,
  });

  return verifyCapturedAssets(db, intent, identity);
}

/** Every resumed v2 Flow reads its owned capture, rather than the mutable global installation. */
export async function taskLaunchFlowAssetsPathForRun(
  db: Db,
  run: Pick<Run, "id" | "projectId" | "taskLaunchIntentId" | "flowRevisionId">,
): Promise<string | null> {
  if (!run.taskLaunchIntentId) return null;
  const [intent] = await db
    .select()
    .from(intents)
    .where(
      and(
        eq(intents.id, run.taskLaunchIntentId),
        eq(intents.originalRunId, run.id),
      ),
    );
  const identity = intent?.preparationIdentity;

  if (
    !intent ||
    intent.projectId !== run.projectId ||
    intent.settingsSnapshot.kind !== "flow" ||
    intent.settingsSnapshot.flowRevisionId !== run.flowRevisionId ||
    !identity ||
    identity.version !== 1 ||
    identity.runId !== run.id
  )
    throw assetsChanged();

  return verifyCapturedAssets(db, intent, identity);
}
