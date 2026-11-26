import "server-only";

import type { Db } from "./db";
import type { WorkspaceInputFile } from "./workspace-inputs";
import type { TaskLaunchSettingsV2Snapshot } from "@/lib/tasks/launch-types";
import type { AddressedPackageSkill } from "../../../runtime/package-skill-tree";
import type { FlowDeliverySnapshot } from "@/lib/capabilities/package-delivery";

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";

import {
  hasWorkspaceInputPathCollision,
  isWorkspaceInputPath,
  WORKSPACE_FLOW_ASSET_DIRECTORY,
  WORKSPACE_INPUT_MAX_BYTES,
  WORKSPACE_INPUT_MAX_FILES,
} from "../../../runtime/workspace-input-policy";
import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";
import {
  ADDRESSED_PACKAGE_SKILL_SLUG,
  packageSkillManifestDigest,
} from "../../../runtime/package-skill-tree";
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

function workspaceBundleCollector() {
  const { files, collect } = workspaceInputCollector();
  const collectRoot = async (
    installedPath: string,
    index: number,
  ): Promise<void> => {
    for (const tree of ["skills", "agents"] as const) {
      const source = path.join(installedPath, tree);
      try {
        await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await collect(
        installedPath,
        source,
        `bundles/${index}/${tree}`,
        new Set(),
      );
    }
  };

  return { files, collectRoot };
}

/** Capture the providing package's adapter assets through its private verified roots. */
export async function captureAddressedAgentPackages(
  roots: readonly string[],
  selection: readonly string[] | undefined,
): Promise<{
  files: readonly WorkspaceInputFile[];
  skills: readonly AddressedPackageSkill[];
}> {
  const { files, collectRoot } = workspaceBundleCollector();

  for (const [index, root] of roots.entries()) await collectRoot(root, index);

  return { files, skills: captureAddressedAgentSkills(files, selection) };
}

/** Capture adapter-facing Flow bundle assets from their verified private snapshot. */
export async function captureWorkspaceBundles(
  db: Db,
  input: Readonly<{
    projectId: string;
    runId: string;
    intentId?: string;
    delivery?: FlowDeliverySnapshot;
    acceptedBundles?: Extract<
      TaskLaunchSettingsV2Snapshot,
      { kind: "flow" }
    >["capabilityBundles"];
  }>,
): Promise<readonly WorkspaceInputFile[]> {
  const { files, collectRoot } = workspaceBundleCollector();
  const bundles =
    input.acceptedBundles ??
    (await captureTaskLaunchCapabilityBundles(db, input.projectId));

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
        await collectRoot(installedPath, index);
    },
  );

  let index = bundles.length;
  const captured = new Set(bundles.map(({ id }) => id));

  for (const pin of input.delivery?.packages ?? []) {
    const missing = pin.bundleIds.filter((id) => !captured.has(id));
    if (!missing.length) continue;
    const {
      rows: [install],
    } = await db.execute(sql`
      SELECT i.installed_path AS root
      FROM package_installs i JOIN project_package_attachments a ON a.package_name=i.name
      WHERE a.project_id=${input.projectId} AND i.id=${pin.installId}
        AND i.resolved_revision=${pin.revision} AND i.package_status='Installed'
        AND i.trust_status IN ('trusted', 'trusted_by_policy')
    `);
    if (typeof install?.root !== "string")
      throw invalidCapture("package_skill_view_integrity");
    const root = await realpath(install.root);

    const collectPackageMember = async (
      id: string,
      bundleIndex: number,
    ): Promise<void> => {
      const member = pin.bundlePaths?.[id];

      if (!member || !isWorkspaceInputPath(member))
        throw invalidCapture("package_skill_view_integrity");

      const memberRoot = await realpath(path.join(root, member));

      if (!contains(root, memberRoot))
        throw invalidCapture("package_skill_view_integrity");
      await collectRoot(memberRoot, bundleIndex);
    };

    for (const id of missing) await collectPackageMember(id, index++);
  }

  return files;
}

/** Witness standalone skills from the same immutable bytes that enter workspace preparation. */
function captureAddressedAgentSkills(
  files: readonly WorkspaceInputFile[],
  selection: readonly string[] | undefined,
): AddressedPackageSkill[] {
  const byTree = new Map<
    string,
    {
      slug: string;
      files: { path: string; sha256: string }[];
    }
  >();

  for (const file of files) {
    const match = /^(bundles\/\d+\/skills\/([^/]+))\/(.+)$/.exec(file.path);

    if (!match || (selection && !selection.includes(match[2]))) continue;
    const [, treePath, slug, relativePath] = match;
    const tree = byTree.get(treePath) ?? { slug, files: [] };

    tree.files.push({
      path: relativePath,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
    byTree.set(treePath, tree);
  }
  const skills = new Map<string, string>();

  for (const { slug, files } of byTree.values()) {
    if (!files.some(({ path }) => path === "SKILL.md")) continue;
    if (
      slug.length > 128 ||
      !ADDRESSED_PACKAGE_SKILL_SLUG.test(slug) ||
      skills.has(slug)
    )
      throw new MaisterError(
        "CONFIG",
        `Addressed package skill ${slug} has an invalid or ambiguous identity`,
      );

    skills.set(slug, packageSkillManifestDigest(files));
  }
  const missing = selection?.find((slug) => !skills.has(slug));

  if (missing)
    throw new MaisterError(
      "PRECONDITION",
      `Selected package skill ${missing} is unavailable`,
      {
        details: { reason: "package_skill_view_integrity", slug: missing },
      },
    );

  return [...skills]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, treeDigest]) => ({ slug, treeDigest }));
}
