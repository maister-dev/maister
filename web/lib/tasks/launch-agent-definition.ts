import "server-only";

import type { OperationalProbeContext } from "@/lib/agents/operational-diagnostics";
import type { Db } from "@/lib/execution-host/db";
import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { Run } from "@/lib/db/schema";
import type { PackageInstallManifest } from "@/lib/packages/attach";

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import {
  taskAgentPackageContentDigest,
  taskAgentPackageChanged,
} from "./launch-agent-resolution";
import { launchRefusal } from "./launch-resolution";
import { captureAcceptedDirectory } from "./launch-capability-materialization";
import { assertManagedCapturePath } from "./launch-capture-path";

import { reportPreparationCleanupFailure } from "@/lib/agents/preparation-trace";
import { packageInstalls, taskLaunchIntents } from "@/lib/db/schema";
import { splitQualifiedAgentId } from "@/lib/agents/effective";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { retryDigest } from "@/lib/agents/retry-guards";
import { MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/runtime-root";
import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";

/** Preserve exact pending/fenced authority while recording failed private cleanup. */
export async function releaseTaskAgentCaptureAfterFailure(
  capture: Readonly<{ release: () => Promise<void> }>,
  originalError: unknown,
  context?: OperationalProbeContext,
): Promise<unknown> {
  try {
    await capture.release();
  } catch (cleanupError) {
    reportPreparationCleanupFailure({
      cleanupOperation: "agent_package.release",
      primaryError: originalError,
      cleanupError,
      context,
    });
  }

  return originalError;
}

async function readTaskAgentDefinitionSource(
  sourcePath: string,
): Promise<string> {
  try {
    return await readFile(sourcePath, "utf8");
  } catch (cause) {
    throw new MaisterError(
      "PRECONDITION",
      "The accepted agent definition cannot be read; inspect its installation and launch again",
      { details: { reason: "launch_agent_definition_changed" }, cause },
    );
  }
}

/** Load the accepted immutable install, never today's project pin or catalog prompt. */
export async function pinnedTaskAgentDefinition(
  db: Db,
  input: {
    agentId: string;
    packageInstallId: string;
    definitionSha256: string;
    packageContentDigest: string;
    manifestDigest: string;
  },
): Promise<EffectiveAgentDefinition> {
  const [install] = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, input.packageInstallId));
  const { packageName, stem } = splitQualifiedAgentId(input.agentId);

  if (
    !install ||
    install.name !== packageName ||
    install.packageStatus !== "Installed" ||
    !["trusted", "trusted_by_policy"].includes(install.trustStatus)
  )
    throw launchRefusal("launch_agent_package_unavailable", "PRECONDITION");
  if (
    (await taskAgentPackageContentDigest(install.installedPath)) !==
    input.packageContentDigest
  )
    throw launchRefusal("launch_agent_package_changed", "PRECONDITION");
  if (retryDigest(install.manifest) !== input.manifestDigest)
    throw launchRefusal("launch_agent_package_changed", "PRECONDITION");
  const sourcePath = path.join(
    install.installedPath,
    "maister-agents",
    `${stem}.md`,
  );
  const parsed = parseAgentDefinition(
    input.agentId,
    await readTaskAgentDefinitionSource(sourcePath),
  );

  if (parsed.kind !== "code_delivery" || parsed.flow)
    throw launchRefusal("launch_agent_definition_changed", "PRECONDITION");

  const definition: EffectiveAgentDefinition = {
    parsed,
    sourcePath,
    packageName,
    packageInstallId: install.id,
    installedPath: install.installedPath,
    manifest: install.manifest as PackageInstallManifest,
    versionLabel: install.versionLabel,
    resolvedRevision: install.resolvedRevision,
    execTrust: "trusted",
  };

  if (
    buildAgentActivitySnapshot(input.agentId, definition).definitionSha256 !==
    input.definitionSha256
  )
    throw launchRefusal("launch_agent_definition_changed", "PRECONDITION");

  return definition;
}

/** The materializer consumes only this verified private package, including its actual definition bytes. */
export async function captureTaskAgentPackage(
  db: Db,
  run: Pick<
    Run,
    | "id"
    | "taskLaunchIntentId"
    | "agentId"
    | "projectId"
    | "taskId"
    | "executionAssignmentId"
  >,
): Promise<
  Readonly<{
    definition: EffectiveAgentDefinition;
    assertCurrentPath: () => Promise<void>;
    release: () => Promise<void>;
  }>
> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(run.id))
    throw launchRefusal("launch_capture_path_invalid", "CONFIG");
  const definition = await frozenTaskAgentDefinition(db, run);
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, run.taskLaunchIntentId ?? ""));
  const settings = intent?.settingsSnapshot;

  if (
    !definition ||
    settings?.version !== 2 ||
    settings.kind !== "agent" ||
    !settings.agentSnapshot
  )
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");
  await mkdir(runtimeRoot(), { recursive: true });
  const directory = await assertManagedCapturePath(
    path.join(runtimeRoot(), ".maister", "accepted-agent-captures", run.id),
  );

  await mkdir(directory, { recursive: true });
  const ownedDirectory = await assertManagedCapturePath(directory);
  const captureDirectory = await mkdtemp(path.join(ownedDirectory, "package-"));
  const capturedPath = await assertManagedCapturePath(
    path.join(captureDirectory, "source"),
  );
  const assertCurrentPath = async (): Promise<void> => {
    await assertManagedCapturePath(capturedPath);
  };
  const release = async (): Promise<void> => {
    const ownedCapture = await assertManagedCapturePath(captureDirectory);

    await rm(ownedCapture, { recursive: true });
  };

  try {
    const links = await captureAcceptedDirectory(
      definition.installedPath,
      capturedPath,
      settings.agentSnapshot.packageContentDigest,
    ).catch((cause: unknown) => {
      if (cause instanceof MaisterError) throw cause;
      throw taskAgentPackageChanged(cause);
    });

    await assertCurrentPath();

    for (const capability of definition.manifest?.spec?.capabilities ?? []) {
      const relativeRoot = `${capability.path}${path.sep}`;

      for (const link of links) {
        if (!link.relativePath.startsWith(relativeRoot)) continue;
        const sourceKind = link.relativePath
          .slice(relativeRoot.length)
          .split(path.sep)[0];
        const targetKind = link.relativeTarget.startsWith(relativeRoot)
          ? link.relativeTarget.slice(relativeRoot.length).split(path.sep)[0]
          : null;

        if (
          ["skills", "agents"].includes(sourceKind) &&
          targetKind !== sourceKind
        )
          throw launchRefusal("launch_capabilities_changed", "PRECONDITION");
      }
    }
    const { stem } = splitQualifiedAgentId(settings.agentId);
    const sourcePath = path.join(capturedPath, "maister-agents", `${stem}.md`);
    const parsed = parseAgentDefinition(
      settings.agentId,
      await readTaskAgentDefinitionSource(sourcePath),
    );

    await assertCurrentPath();

    if (
      buildAgentActivitySnapshot(settings.agentId, { ...definition, parsed })
        .definitionSha256 !== settings.definitionSha256
    )
      throw launchRefusal("launch_agent_definition_changed", "PRECONDITION");

    return {
      assertCurrentPath,
      definition: {
        ...definition,
        installedPath: capturedPath,
        sourcePath,
        parsed,
      },
      release,
    };
  } catch (error) {
    await releaseTaskAgentCaptureAfterFailure({ release }, error, {
      runId: run.id,
      ...(run.executionAssignmentId
        ? { assignmentId: run.executionAssignmentId }
        : {}),
      stage: "package_capture",
    });
    throw error;
  }
}

/** Legacy and operational runs keep their existing readers; accepted agent runs require their exact snapshot. */
export async function frozenTaskAgentDefinition(
  db: Db,
  run: Pick<
    Run,
    "id" | "taskLaunchIntentId" | "agentId" | "projectId" | "taskId"
  >,
): Promise<EffectiveAgentDefinition | null> {
  if (!run.taskLaunchIntentId) return null;
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, run.taskLaunchIntentId));
  const settings = intent?.settingsSnapshot;

  if (
    !intent ||
    intent.originalRunId !== run.id ||
    intent.projectId !== run.projectId ||
    intent.taskId !== run.taskId ||
    settings.version !== 2 ||
    settings.kind !== "agent" ||
    settings.agentId !== run.agentId ||
    !settings.agentSnapshot
  )
    throw launchRefusal("launch_agent_snapshot_incomplete", "PRECONDITION");

  return pinnedTaskAgentDefinition(db, {
    agentId: settings.agentId,
    ...settings.agentSnapshot,
  });
}
