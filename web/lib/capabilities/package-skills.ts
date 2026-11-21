import "server-only";

import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import {
  agentMaterializationPathsForRun,
  assertSafeAgentMaterializationPath,
  materializeWithAgentLease,
} from "@/lib/agents/materialization-manifest";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import { SLUG_PATTERN } from "@/lib/capabilities/token-normalizer";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "package-skills",
  level: process.env.LOG_LEVEL ?? "info",
});

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
export async function materializeWorkspacePackageSkills(args: {
  cwd: string;
  runId: string;
  installedPaths: readonly string[];
}): Promise<string[]> {
  const skills = new Map<string, string>();

  for (const installedPath of args.installedPaths) {
    const source = path.join(installedPath, "skills");

    for (const slug of await skillEntries(source)) {
      if (!skills.has(slug)) skills.set(slug, path.join(source, slug));
    }
  }

  if (skills.size === 0) return [];
  const cwd = await assertSafeAgentMaterializationPath(
    args.cwd,
    ".maister/capabilities",
  );
  const root = skillRoot(cwd, args.runId);
  const relative = path.relative(cwd, root);
  const paths = await materializeWithAgentLease({
    cwd,
    runId: args.runId,
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
      await mkdir(root, { recursive: true });
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

      return [root];
    },
  });

  log.debug(
    { runId: args.runId, skillCount: skills.size },
    "packaged skills materialized within session workspace",
  );

  return paths;
}

export async function workspacePackageSkillsPrompt(
  cwd: string,
  runId: string,
): Promise<string> {
  const root = skillRoot(cwd, runId);
  const relative = path.relative(cwd, root);

  if (!(await entryStat(root))) return "";
  if (!(await agentMaterializationPathsForRun(cwd, runId)).includes(relative))
    return "";
  await assertSafeAgentMaterializationPath(cwd, relative);
  const skills = await skillEntries(root);

  if (skills.length === 0) return "";

  return [
    "## Packaged skills",
    "When the task or agent instructions require a packaged skill, read its SKILL.md using the workspace-relative path below. Use this copy for the packaged instructions and resolve its companion files relative to SKILL.md.",
    ...skills.map((slug) => `- ${slug}: \`${relative}/${slug}/SKILL.md\``),
  ].join("\n");
}

export function appendPackageSkillsPrompt(
  prompt: string,
  skillsPrompt: string,
): string {
  return skillsPrompt ? `${prompt}\n\n${skillsPrompt}` : prompt;
}
