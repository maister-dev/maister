import type { WorkspaceAssignmentOwner } from "../../runtime/workspace-prepare";
import type { executeWorkspaceWorkloadProcess } from "./workspace-workload-process";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  isWorkspaceInputPath,
  WORKSPACE_FLOW_ASSET_DIRECTORY,
  WORKSPACE_INPUT_MAX_BYTES,
  WORKSPACE_INPUT_MAX_FILES,
} from "../../runtime/workspace-input-policy";
import { workspaceEvidenceDigest } from "../../runtime/workspace-prepare";

import { withSqliteFileLock } from "./sqlite-file-lock";
import { SupervisorError } from "./types";
import {
  materializeWorkspaceFlowAssets,
  workspaceFlowAssetDigest,
} from "./workspace-input-materialization";

type SetupSource = Readonly<{
  inputDirectory: string;
  manifestDigest: string;
  runtimeRoot: string;
  revision: string;
  projectSlug: string;
  owner: WorkspaceAssignmentOwner;
}>;
type ProcessResult = Awaited<
  ReturnType<typeof executeWorkspaceWorkloadProcess>
>;
type PreparedAssetEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; sha256: string; mode: number };

function unavailable(message: string, cause?: unknown): SupervisorError {
  return new SupervisorError("PRECONDITION", message, {
    cause,
    details: { reason: "workspace_setup_unavailable" },
  });
}

async function setupRoot(source: SetupSource): Promise<string> {
  const digest = await workspaceFlowAssetDigest(
    source.inputDirectory,
    source.manifestDigest,
  );
  const key = workspaceEvidenceDigest([
    source.owner.hostKey,
    source.projectSlug,
    source.revision,
    digest,
  ]);

  return join(
    await realpath(source.runtimeRoot),
    ".maister",
    "flow-setup",
    key,
  );
}

async function completedFingerprint(root: string): Promise<string | null> {
  try {
    const path = join(root, "complete");

    if ((await realpath(path)) !== path)
      throw unavailable("Flow setup receipt is not canonical");
    const stat = await lstat(path);

    if (!stat.isFile() || stat.size !== 64 || stat.nlink !== 1)
      throw unavailable("Flow setup receipt is invalid");
    const digest = await readFile(path, "utf8");

    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw unavailable("Flow setup receipt is invalid");

    return digest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function inspectSetupFiles(directory: string): Promise<{
  entries: readonly PreparedAssetEntry[];
  fingerprint: string;
}> {
  if ((await realpath(directory)) !== directory)
    throw unavailable("Flow setup asset directory is not canonical");
  const entries: PreparedAssetEntry[] = [];
  let count = 0;
  let bytes = 0;
  const walk = async (parent: string): Promise<void> => {
    for await (const entry of await opendir(join(directory, parent))) {
      count += 1;
      if (count > WORKSPACE_INPUT_MAX_FILES)
        throw unavailable("Flow setup exceeded its package asset entry budget");
      const path = parent ? parent + "/" + entry.name : entry.name;

      if (!isWorkspaceInputPath(path))
        throw unavailable(
          "Flow setup produced an unsupported package asset path",
        );
      if (entry.isDirectory()) {
        entries.push({ path, kind: "directory" });
        await walk(path);
        continue;
      }
      if (!entry.isFile())
        throw unavailable("Flow setup produced an unsupported package asset");
      const file = await open(
        join(directory, path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );

      try {
        const stat = await file.stat();

        if (!stat.isFile() || stat.nlink !== 1)
          throw unavailable("Flow setup produced an unsupported package asset");
        const hash = createHash("sha256");

        for await (const chunk of file.createReadStream({ autoClose: false })) {
          bytes += chunk.length;
          if (bytes > WORKSPACE_INPUT_MAX_BYTES)
            throw unavailable(
              "Flow setup exceeded its package asset byte budget",
            );
          hash.update(chunk);
        }
        entries.push({
          path,
          kind: "file",
          sha256: hash.digest("hex"),
          mode: stat.mode & 0o777,
        });
      } finally {
        await file.close();
      }
    }
  };

  await walk("");
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  return {
    entries,
    fingerprint: workspaceEvidenceDigest(entries),
  };
}

/** The receipt is published once, only after a successful, retired host process. */
export async function runFlowSetup(
  source: SetupSource,
  effect: (cwd: string) => Promise<ProcessResult>,
  assertOwner: () => void,
): Promise<{ kind: "reused" } | { kind: "executed"; result: ProcessResult }> {
  const root = await setupRoot(source);
  const parent = dirname(root);

  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent)
    throw unavailable("Flow setup cache root is not canonical");

  return withSqliteFileLock(root, async () => {
    assertOwner();
    const completed = await completedFingerprint(root);

    if (completed) {
      const { fingerprint } = await inspectSetupFiles(
        join(root, WORKSPACE_FLOW_ASSET_DIRECTORY),
      );

      if (fingerprint !== completed)
        throw unavailable(
          "Retained Flow setup assets changed after completion",
        );

      return { kind: "reused" };
    }
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw unavailable(
        "A previous setup has no successful receipt for this revision. Inspect the owning supervisor before retrying.",
        error,
      );
    }
    const cwd = await materializeWorkspaceFlowAssets({
      ...source,
      commandDirectory: root,
    });

    assertOwner();
    const result = await effect(cwd);

    if (
      result.retired &&
      result.processOutcome === "exited" &&
      result.exitCode === 0
    ) {
      const { fingerprint } = await inspectSetupFiles(cwd);

      assertOwner();
      await writeFile(join(root, "complete"), fingerprint, {
        flag: "wx",
        mode: 0o400,
        flush: true,
      });
    }

    return { kind: "executed", result };
  });
}

/** A command sees its own copy, so writes never modify the setup generation for a later Run. */
export async function copyPreparedFlowAssets(
  source: SetupSource,
  commandDirectory: string,
): Promise<string> {
  const root = await setupRoot(source);
  const completed = await completedFingerprint(root);

  if (!completed)
    throw unavailable(
      "The selected supervisor has no successful setup for this Flow revision",
    );
  const assets = join(root, WORKSPACE_FLOW_ASSET_DIRECTORY);
  const { entries, fingerprint } = await inspectSetupFiles(assets);

  if (fingerprint !== completed)
    throw unavailable("Retained Flow setup assets changed after completion");
  const target = join(commandDirectory, WORKSPACE_FLOW_ASSET_DIRECTORY);

  await mkdir(target, { mode: 0o700 });
  for (const entry of entries) {
    const destination = join(target, entry.path);

    if (entry.kind === "directory") await mkdir(destination, { mode: 0o700 });
    else
      await copyFile(
        join(assets, entry.path),
        destination,
        constants.COPYFILE_EXCL,
      );
  }
  if ((await inspectSetupFiles(target)).fingerprint !== completed)
    throw unavailable("Flow setup assets changed while copying them");

  return target;
}
