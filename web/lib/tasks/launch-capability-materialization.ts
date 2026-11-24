import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchSettingsV2Snapshot } from "./launch-types";
import type { CapabilityBundleSource } from "@/lib/capabilities/materialize-bundle";

import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { asc } from "drizzle-orm";
import pino from "pino";

import { taskLaunchCapabilityChanged as changedCapability } from "./launch-capabilities";
import { assertManagedCapturePath } from "./launch-capture-path";

import { eligibleProjectImport } from "@/lib/project-dependencies/eligible-imports";
import { capabilityImports } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { localDirectoryContentDigest } from "@/lib/flows";
import { operationalCauseChain } from "@/lib/agents/operational-diagnostics";
import { runtimeRoot } from "@/lib/runtime-root";

const log = pino({
  name: "task-launch-capability-capture",
  level: process.env.LOG_LEVEL ?? "info",
});

type FrozenCapabilityBundles = NonNullable<
  TaskLaunchSettingsV2Snapshot["capabilityBundles"]
>;

function withinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export type AcceptedDirectorySymlink = Readonly<{
  relativePath: string;
}>;

async function readInternalDirectorySymlinks(
  root: string,
  directory: string,
): Promise<ReadonlyArray<AcceptedDirectorySymlink>> {
  const links: AcceptedDirectorySymlink[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory())
      links.push(...(await readInternalDirectorySymlinks(root, entryPath)));
    else if (entry.isSymbolicLink()) {
      const target = await readlink(entryPath);

      if (
        path.isAbsolute(target) ||
        !withinDirectory(root, path.resolve(directory, target))
      )
        throw changedCapability();
      const resolvedTarget = await realpath(entryPath);

      if (!withinDirectory(root, resolvedTarget)) throw changedCapability();
      links.push({
        relativePath: path.relative(root, entryPath),
      });
    }
  }

  return links;
}

/** Capture mutable installation bytes once. Hash the private copy, never infer copied content from source probes. */
export async function captureAcceptedDirectory(
  sourcePath: string,
  capturedPath: string,
  expectedDigest: string,
): Promise<ReadonlyArray<AcceptedDirectorySymlink>> {
  await cp(sourcePath, capturedPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  const root = await lstat(capturedPath);

  if (!root.isDirectory() || root.isSymbolicLink()) throw changedCapability();
  if ((await localDirectoryContentDigest(capturedPath)) !== expectedDigest)
    throw changedCapability();

  return readInternalDirectorySymlinks(capturedPath, capturedPath);
}

/** Validate each hop in the private capture before delivering a subset verbatim. */
export async function assertCapturedProjectionSymlinks(
  capture: string,
  links: ReadonlyArray<AcceptedDirectorySymlink>,
  projectedTrees: readonly string[],
): Promise<void> {
  const roots = projectedTrees.map((tree) => path.join(capture, tree));

  if (roots.some((root) => root === capture || !withinDirectory(capture, root)))
    throw changedCapability();
  for (const link of links) {
    const source = path.join(capture, link.relativePath);

    if (!roots.some((root) => withinDirectory(root, source))) continue;
    let current = capture;
    const remaining = link.relativePath.split(path.sep);

    // Resolving ".." before a symlink hop would change its physical meaning.
    while (remaining.length) {
      const segment = remaining.shift()!;

      if (segment === "" || segment === ".") continue;
      const next = path.join(current, segment);

      if (
        !withinDirectory(capture, next) ||
        !roots.some(
          (root) => withinDirectory(root, next) || withinDirectory(next, root),
        )
      ) {
        log.warn(
          { reason: "omitted_projection_component" },
          "accepted package link crosses omitted content",
        );
        throw changedCapability();
      }
      if ((await lstat(next)).isSymbolicLink()) {
        const target = await readlink(next);

        remaining.unshift(...target.split(path.sep));
      } else {
        current = next;
      }
    }
    if (!roots.some((root) => withinDirectory(root, current)))
      throw changedCapability();
  }
}

/** The worker owns the private capture under its existing physical fence; only these captured bytes reach the checkout. */
export async function withTaskLaunchCapabilityBundles(
  db: Db,
  input: Readonly<{
    projectId: string;
    intentId: string;
    runId: string;
    directory: string;
    bundles: FrozenCapabilityBundles;
  }>,
  effect: (bundles: ReadonlyArray<CapabilityBundleSource>) => Promise<void>,
): Promise<void> {
  const imports = await db
    .select()
    .from(capabilityImports)
    .where(eligibleProjectImport(input.projectId))
    .orderBy(asc(capabilityImports.id));

  if (imports.length !== input.bundles.length) throw changedCapability();
  const sources = input.bundles.map((accepted) => {
    const installed = imports.find((candidate) => candidate.id === accepted.id);

    if (
      !installed ||
      installed.resolvedRevision !== accepted.revision ||
      installed.manifestDigest !== accepted.manifestDigest
    )
      throw changedCapability();

    return { accepted, installedPath: installed.installedPath };
  });

  if (sources.length === 0) {
    await effect([]);

    return;
  }
  await mkdir(runtimeRoot(), { recursive: true });
  const directory = await assertManagedCapturePath(input.directory);

  await mkdir(directory, { recursive: true });
  const captureParent = await assertManagedCapturePath(directory);
  const captureDirectory = await mkdtemp(
    path.join(captureParent, "capability-capture-"),
  );
  let failure: Readonly<{ error: unknown }> | null = null;

  try {
    const captureRoot = await assertManagedCapturePath(captureDirectory);
    const captures: CapabilityBundleSource[] = [];

    for (const [index, source] of sources.entries()) {
      const capturedPath = path.join(captureRoot, String(index));

      let links: ReadonlyArray<AcceptedDirectorySymlink>;

      try {
        links = await captureAcceptedDirectory(
          source.installedPath,
          capturedPath,
          source.accepted.contentDigest,
        );
        await assertCapturedProjectionSymlinks(capturedPath, links, [
          "skills",
          "agents",
        ]);
      } catch (cause) {
        if (cause instanceof MaisterError) throw cause;
        throw changedCapability(cause);
      }

      captures.push({
        installedPath: await assertManagedCapturePath(capturedPath),
      });
    }
    log.debug(
      {
        projectId: input.projectId,
        intentId: input.intentId,
        runId: input.runId,
        bundleCount: captures.length,
      },
      "[FIX:launch-capability-capture] accepted bundle bytes verified before materialization",
    );
    await assertManagedCapturePath(captureRoot);
    await effect(captures);
  } catch (error) {
    failure = { error };
  }
  try {
    const ownedCapture = await assertManagedCapturePath(captureDirectory);

    await rm(ownedCapture, { recursive: true });
  } catch (error) {
    if (failure) {
      log.error(
        {
          projectId: input.projectId,
          intentId: input.intentId,
          runId: input.runId,
          reason: "launch_capability_capture_cleanup_failed",
          causeChain: operationalCauseChain(error),
        },
        "[FIX:launch-capability-capture] private capture cleanup also failed; preserving original failure",
      );
      throw failure.error;
    }
    throw new MaisterError(
      "PRECONDITION",
      "The private capability capture could not be removed; inspect the preparation details before retrying",
      {
        details: {
          reason: "launch_capability_capture_cleanup_failed",
          stage: "capability_capture_cleanup",
        },
        cause: error,
      },
    );
  }
  if (failure) throw failure.error;
}
