import "server-only";

import type { Db } from "./db";
import type { WorkspaceInputFile } from "./workspace-inputs";
import type { TaskLaunchSettingsV2Snapshot } from "@/lib/tasks/launch-types";

import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  hasWorkspaceInputPathCollision,
  isWorkspaceInputPath,
  WORKSPACE_FLOW_ASSET_DIRECTORY,
  WORKSPACE_INPUT_MAX_BYTES,
  WORKSPACE_INPUT_MAX_FILES,
} from "../../../runtime/workspace-input-policy";
import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";
import { MAX_RUNTIME_OBJECT_BYTES } from "./runtime-objects";

import { MaisterError } from "@/lib/errors";
import { runtimeRoot } from "@/lib/runtime-root";
import { captureTaskLaunchCapabilityBundles } from "@/lib/tasks/launch-capabilities";
import { withTaskLaunchCapabilityBundles } from "@/lib/tasks/launch-capability-materialization";

function invalidCapture(reason: string): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Cannot capture the selected workspace inputs",
    {
      details: { reason },
    },
  );
}

type WorkspaceInputCapture = {
  files: readonly { path: string; base64: string; executable?: true }[];
  contentDigest: string;
};

export function encodeWorkspaceInputCapture(
  files: readonly WorkspaceInputFile[],
): WorkspaceInputCapture {
  let bytes = 0;

  if (files.length > WORKSPACE_INPUT_MAX_FILES)
    throw invalidCapture("launch_input_limit");
  if (hasWorkspaceInputPathCollision(files.map(({ path }) => path)))
    throw invalidCapture("workspace_input_path_invalid");
  const entries = files.map(({ path, bytes: content, executable }) => {
    if (!isWorkspaceInputPath(path))
      throw invalidCapture("workspace_input_path_invalid");
    bytes += content.byteLength;
    if (
      content.byteLength > MAX_RUNTIME_OBJECT_BYTES ||
      bytes > WORKSPACE_INPUT_MAX_BYTES
    )
      throw invalidCapture("launch_input_limit");

    return {
      path,
      base64: Buffer.from(content).toString("base64"),
      ...(executable ? { executable } : {}),
    };
  });
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path === right.path ? 0 : 1,
  );

  return { files: entries, contentDigest: workspaceEvidenceDigest(entries) };
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function workspaceInputCollector() {
  const files: WorkspaceInputFile[] = [];
  let totalBytes = 0;
  const collect = async (
    root: string,
    source: string,
    target: string,
    parents: ReadonlySet<string>,
  ): Promise<void> => {
    if (!isWorkspaceInputPath(target))
      throw invalidCapture("workspace_input_path_invalid");
    const physical = await realpath(source);
    if (!contains(root, physical) || parents.has(physical))
      throw invalidCapture("workspace_input_path_invalid");
    const entry = await stat(physical);

    if (entry.isDirectory()) {
      const ancestry = new Set([...parents, physical]);

      for (const name of await readdir(physical))
        await collect(
          root,
          path.join(physical, name),
          `${target}/${name}`,
          ancestry,
        );

      return;
    }
    if (!entry.isFile()) throw invalidCapture("workspace_input_path_invalid");
    if (
      files.length >= WORKSPACE_INPUT_MAX_FILES ||
      entry.size > MAX_RUNTIME_OBJECT_BYTES ||
      entry.size + totalBytes > WORKSPACE_INPUT_MAX_BYTES
    )
      throw invalidCapture("launch_input_limit");
    const bytes = await readFile(physical);
    totalBytes += bytes.byteLength;
    if (totalBytes > WORKSPACE_INPUT_MAX_BYTES)
      throw invalidCapture("launch_input_limit");
    files.push({
      path: target,
      bytes,
      ...(target.startsWith(WORKSPACE_FLOW_ASSET_DIRECTORY + "/") &&
      (entry.mode & 0o111) !== 0
        ? { executable: true as const }
        : {}),
    });
  };

  return { files, collect };
}

export async function captureWorkspaceFlowAssets(
  directory: string,
): Promise<readonly WorkspaceInputFile[]> {
  const root = await realpath(directory);
  const collector = workspaceInputCollector();
  await collector.collect(
    root,
    root,
    WORKSPACE_FLOW_ASSET_DIRECTORY,
    new Set(),
  );

  return collector.files;
}

/** Copy only adapter-facing package assets from the already verified private snapshot. */
export async function captureWorkspaceBundles(
  db: Db,
  input: Readonly<{
    projectId: string;
    runId: string;
    intentId?: string;
    agentPackageRoots?: readonly string[];
    acceptedBundles?: Extract<
      TaskLaunchSettingsV2Snapshot,
      { kind: "flow" }
    >["capabilityBundles"];
  }>,
): Promise<readonly WorkspaceInputFile[]> {
  const { files, collect } = workspaceInputCollector();
  const bundles =
    input.acceptedBundles ??
    (await captureTaskLaunchCapabilityBundles(db, input.projectId));
  const agentRoots = input.agentPackageRoots ?? [];
  const collectRoot = async (installedPath: string, index: number): Promise<void> => {
    for (const tree of ["skills", "agents"] as const) {
      const source = path.join(installedPath, tree);
      try {
        await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await collect(installedPath, source, `bundles/${index}/${tree}`, new Set());
    }
  };
  for (const [index, root] of agentRoots.entries()) await collectRoot(root, index);

  await withTaskLaunchCapabilityBundles(
    db,
    {
      projectId: input.projectId,
      runId: input.runId,
      intentId: input.intentId ?? input.runId,
      directory: path.join(runtimeRoot(), "workspace-input-captures"),
      bundles,
    },
    async (sources) => {
      for (const [index, { installedPath }] of sources.entries())
        await collectRoot(installedPath, index + agentRoots.length);
    },
  );

  return files;
}
