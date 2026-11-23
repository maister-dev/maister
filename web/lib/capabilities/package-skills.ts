import "server-only";

import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import {
  agentMaterializationPathsForRun,
  assertSafeAgentMaterializationPath,
  materializeWithAgentLease,
} from "@/lib/agents/materialization-manifest";
import {
  packageSkillTreeDigest,
  type PackageSkillView,
} from "../../../runtime/package-skill-tree";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import type {
  FlowDeliverySnapshot,
  PackageSkillWitness,
} from "./package-delivery";
import { createHash } from "node:crypto";
import { SLUG_PATTERN } from "@/lib/capabilities/token-normalizer";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "package-skills",
  level: process.env.LOG_LEVEL ?? "info",
});

type WorkspaceSkillProjection = Readonly<{
  cwd: string;
  runId: string;
  installedPaths: readonly string[];
  selectedSkills?: readonly string[];
}>;

const capturedBundlePrefix = ".bundle-";
const capturedBundleName = /^\.bundle-\d+$/u;

function skillRoot(cwd: string, runId: string): string {
  return path.join(
    capabilityMaterializationRootPath(cwd, runId),
    "package-skills",
  );
}

async function entryStat(
  file: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function skillEntries(root: string): Promise<string[]> {
  const metadata = await entryStat(root);

  if (!metadata) return [];
  if (!metadata.isDirectory())
    throw new MaisterError(
      "CONFIG",
      `Package skills path is not a directory: ${root}`,
    );

  const entries = await readdir(root, { withFileTypes: true });
  const skills: string[] = [];

  for (const entry of entries) {
    if (!SLUG_PATTERN.test(entry.name) || !entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    const skill = await entryStat(file);

    if (!skill) continue;
    if (!skill.isFile())
      throw new MaisterError(
        "CONFIG",
        `Packaged skill is not a regular file: ${file}`,
      );
    skills.push(entry.name);
  }

  return skills.sort();
}

/** Publish only package skill directories inside the session's file-tool root. */
export async function materializeWorkspacePackageSkills(
  args: WorkspaceSkillProjection,
): Promise<string[]> {
  const skills = new Map<string, string>();

  for (const installedPath of args.installedPaths) {
    const source = path.join(installedPath, "skills");

    for (const slug of await skillEntries(source)) {
      if (args.selectedSkills && !args.selectedSkills.includes(slug)) continue;
      if (!skills.has(slug)) skills.set(slug, path.join(source, slug));
    }
  }

  for (const slug of args.selectedSkills ?? []) {
    if (!skills.has(slug))
      throw new MaisterError(
        "CONFIG",
        `Selected package skill is missing: ${slug}`,
      );
  }
  if (skills.size === 0) return [];

  return publishSkillProjection(args, async (root) => {
    for (const [slug, source] of skills) {
      await cp(source, path.join(root, slug), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (file) => {
          const metadata = await lstat(file);

          if (metadata.isFile() || metadata.isDirectory()) return true;
          throw new MaisterError(
            "CONFIG",
            `Packaged skill contains a symlink or special file: ${file}`,
          );
        },
      });
    }
  });
}

/** Preserve the layout of private bundles whose bytes and links the launch owner has verified. */
export async function materializeCapturedWorkspacePackageSkills(
  args: WorkspaceSkillProjection,
): Promise<string[]> {
  const bundles: string[] = [];

  for (const source of args.installedPaths) {
    if ((await skillEntries(path.join(source, "skills"))).length > 0)
      bundles.push(source);
  }
  if (bundles.length === 0) return [];

  return publishSkillProjection(args, async (root) => {
    for (const [index, source] of bundles.entries()) {
      const destination = path.join(root, `${capturedBundlePrefix}${index}`);

      await mkdir(destination);
      for (const tree of ["skills", "agents"] as const) {
        const entry = path.join(source, tree);
        const metadata = await entryStat(entry);

        if (!metadata) continue;
        if (!metadata.isDirectory())
          throw new MaisterError(
            "CONFIG",
            `Captured bundle path is not a directory: ${entry}`,
          );
        await cp(entry, path.join(destination, tree), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true,
          filter: async (file) => {
            const captured = await entryStat(file);

            if (
              captured?.isFile() ||
              captured?.isDirectory() ||
              captured?.isSymbolicLink()
            )
              return true;
            throw new MaisterError(
              "CONFIG",
              `Captured bundle entry is missing or a special file: ${file}`,
            );
          },
        });
      }
    }
  });
}

async function publishSkillProjection(
  { cwd: worktree, runId }: Pick<WorkspaceSkillProjection, "cwd" | "runId">,
  copy: (root: string) => Promise<void>,
  subpath?: string,
): Promise<string[]> {
  const cwd = await assertSafeAgentMaterializationPath(
    worktree,
    ".maister/capabilities",
  );
  const root = subpath
    ? path.join(capabilityMaterializationRootPath(cwd, runId), subpath)
    : skillRoot(cwd, runId);
  const relative = path.relative(cwd, root);

  return materializeWithAgentLease({
    cwd,
    runId,
    materialize: async (_owned, recordIntent, ownedByRun) => {
      if (await entryStat(root)) {
        if (!ownedByRun.has(relative))
          throw new MaisterError(
            "CONFLICT",
            `Packaged skill projection already exists without this run's lease: ${relative}`,
          );

        return [root];
      }

      await recordIntent([root]);
      await mkdir(path.dirname(root), { recursive: true });
      await assertSafeAgentMaterializationPath(
        cwd,
        path.relative(cwd, path.dirname(root)),
      );
      const staged = await mkdtemp(root + ".staging-");
      try {
        await copy(staged);
        await rename(staged, root);
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
      log.debug(
        { runId },
        "packaged skills materialized within session workspace",
      );

      return [root];
    },
  });
}

export async function workspacePackageSkillsPrompt(
  cwd: string,
  runId: string,
  nodeAttemptId?: string,
): Promise<string> {
  const root = path.join(
    capabilityMaterializationRootPath(cwd, runId, nodeAttemptId),
    "package-skills",
  );
  const relative = path.relative(cwd, root);

  if (!(await entryStat(root))) return "";
  if (!(await agentMaterializationPathsForRun(cwd, runId)).includes(relative))
    return "";
  await assertSafeAgentMaterializationPath(cwd, relative);
  const skills = new Map(
    (await skillEntries(root)).map((slug) => [
      slug,
      `${relative}/${slug}/SKILL.md`,
    ]),
  );
  const captured = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && capturedBundleName.test(entry.name),
    )
    .sort(
      (left, right) =>
        Number(left.name.slice(capturedBundlePrefix.length)) -
        Number(right.name.slice(capturedBundlePrefix.length)),
    );

  for (const { name } of captured) {
    for (const slug of await skillEntries(path.join(root, name, "skills"))) {
      if (!skills.has(slug))
        skills.set(slug, `${relative}/${name}/skills/${slug}/SKILL.md`);
    }
  }

  if (skills.size === 0) return "";

  return [
    "## Packaged skills",
    "When the task or agent instructions require a packaged skill, read its SKILL.md using the workspace-relative path below. Use this copy for the packaged instructions and resolve its companion files relative to SKILL.md.",
    ...Array.from(skills, ([slug, file]) => `- ${slug}: \`${file}\``),
  ].join("\n");
}

export function appendPackageSkillsPrompt(
  prompt: string,
  skillsPrompt: string,
): string {
  return skillsPrompt ? `${prompt}\n\n${skillsPrompt}` : prompt;
}

function bundleKey(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/** This Run-only staging area is outside every adapter's native discovery directories. */
export function stagePackageSkillInputs(args: {
  cwd: string;
  runId: string;
  delivery: FlowDeliverySnapshot;
  bundles: readonly { id?: string; installedPath: string }[];
}): Promise<string[]> {
  return publishSkillProjection(
    args,
    async (root) => {
      for (const id of args.delivery.packages.flatMap((p) => p.bundleIds)) {
        const bundle = args.bundles.find((b) => b.id === id);
        if (!bundle)
          throw new MaisterError(
            "PRECONDITION",
            `Pinned capability bundle ${id} is unavailable`,
          );
        const source = path.join(bundle.installedPath, "skills");
        if (!(await entryStat(source))) continue;
        await cp(source, path.join(root, bundleKey(id)), {
          recursive: true,
          dereference: true,
          filter: async (file) => {
            const target = await realpath(file);
            const relative = path.relative(
              await realpath(bundle.installedPath),
              target,
            );
            if (
              relative === ".." ||
              relative.startsWith(".." + path.sep) ||
              path.isAbsolute(relative)
            )
              throw new MaisterError(
                "CONFIG",
                "Package skill companion resolves outside its pin",
              );
            const stat = await lstat(target);
            if (!stat.isFile() && !stat.isDirectory())
              throw new MaisterError(
                "CONFIG",
                "Package skill companion must be a regular file or directory",
              );
            return true;
          },
        });
      }
    },
    "package-inputs",
  );
}

/** Publish one flat discovery directory for this attempt, with the same origins as the prompt index. */
export async function materializePackageSessionSkills(args: {
  cwd: string;
  runId: string;
  nodeAttemptId: string;
  delivery: FlowDeliverySnapshot;
  skills: readonly PackageSkillWitness[];
}): Promise<string[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(args.nodeAttemptId))
    throw new MaisterError("CONFIG", "Invalid node attempt identity");
  const paths = await publishSkillProjection(
    args,
    async (root) => {
      for (const skill of args.skills) {
        if (!SLUG_PATTERN.test(skill.slug))
          throw new MaisterError("CONFIG", "Invalid package skill ref");
        const pin = args.delivery.packages.find(
          (p) => p.installId === skill.installId,
        );
        const matches: string[] = [];
        for (const bundle of pin?.bundleIds ?? []) {
          const candidate = path.join(
            capabilityMaterializationRootPath(args.cwd, args.runId),
            "package-inputs",
            bundleKey(bundle),
            skill.slug,
          );
          if ((await entryStat(path.join(candidate, "SKILL.md")))?.isFile())
            matches.push(candidate);
        }
        if (matches.length !== 1)
          throw new MaisterError(
            "PRECONDITION",
            `Expected one pinned source for ${skill.packageName}:${skill.slug}, found ${matches.length}`,
          );
        await assertSafeAgentMaterializationPath(
          args.cwd,
          path.relative(args.cwd, matches[0]!),
        );
        await cp(matches[0]!, path.join(root, skill.slug), {
          recursive: true,
          filter: async (file) => {
            const stat = await lstat(file);
            if (!stat.isFile() && !stat.isDirectory())
              throw new MaisterError(
                "PRECONDITION",
                "Pinned skill contains a replaced path",
              );
            return true;
          },
        });
      }
    },
    path.join(args.nodeAttemptId, "package-skills"),
  );
  const root = path.join(
    capabilityMaterializationRootPath(args.cwd, args.runId, args.nodeAttemptId),
    "package-skills",
  );
  const names = (await readdir(root)).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(args.skills.map((s) => s.slug).sort())
  )
    throw new MaisterError(
      "PRECONDITION",
      "The pinned skill selection changed before dispatch",
    );
  for (const skill of args.skills)
    if (
      skill.digest &&
      (await packageSkillTreeDigest(path.join(root, skill.slug))) !==
        skill.digest
    )
      throw new MaisterError(
        "PRECONDITION",
        `Pinned skill bytes changed: ${skill.packageName}:${skill.slug}`,
      );
  return paths;
}

export async function witnessPackageSkillView(
  cwd: string,
  runId: string,
  attemptId: string,
  settingsPath: string | null,
): Promise<PackageSkillView> {
  return {
    skillsDigest: await packageSkillTreeDigest(
      path.join(
        capabilityMaterializationRootPath(cwd, runId, attemptId),
        "package-skills",
      ),
    ),
    ...(settingsPath
      ? {
          settingsDigest: createHash("sha256")
            .update(await readFile(settingsPath))
            .digest("hex"),
        }
      : {}),
  };
}
