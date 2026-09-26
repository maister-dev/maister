import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  listLaunchableFlowSummaries,
  type ExtFlowSummary,
} from "@/lib/queries/project";

const { agentProjectLinks, agentSchedules, platformAcpRunners, projects } =
  schema;

const log = pino({
  name: "librarian.directory",
  level: process.env.LOG_LEVEL ?? "info",
});

// A README excerpt is a hint about what a project is for, not a document: the
// first paragraph, bounded at read time so a huge file never reaches memory.
export const README_READ_BYTES = 4096;
export const PURPOSE_MAX_CHARS = 600;

export interface ProjectDirectory {
  project: { id: string; slug: string; name: string };
  // First README paragraph, or null when the reader may not read repository
  // files (ADR-053) or the project has no readable README.
  purpose: string | null;
  launchableFlows: ExtFlowSummary[];
  defaultRunner: { id: string; model: string; enabled: boolean } | null;
  triagerConfigured: boolean;
  brainEnabled: boolean;
  asOf: string;
}

function firstParagraph(text: string): string | null {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => !/^\s*(#|<|!\[|\[!\[)/.test(line))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((block) => block.length > 0);
  const first = paragraphs[0];

  if (!first) return null;

  return first.length > PURPOSE_MAX_CHARS
    ? `${first.slice(0, PURPOSE_MAX_CHARS - 1)}…`
    : first;
}

// Positioned, bounded read of `<repoPath>/README.md`. Only a regular file that
// is not a symlink is read, so a README pointing outside the repository is
// never followed.
async function readReadmePurpose(repoPath: string): Promise<string | null> {
  const file = path.join(repoPath, "README.md");
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    // lstat BEFORE open: a symlink is never followed and a FIFO is never
    // opened (an open on one would block).
    const linkStat = await lstat(file);

    if (!linkStat.isFile()) return null;

    handle = await open(file, "r");
    const bytes = new Uint8Array(README_READ_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, README_READ_BYTES, 0);

    return firstParagraph(
      new TextDecoder("utf-8").decode(bytes.subarray(0, bytesRead)),
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ENOTDIR") return null;
    log.warn({ repoPath, code }, "project README unreadable");

    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The librarian's compact routing facts for one project the reader can see:
 * what it is for, what can be launched there, who triages and whether its
 * Brain exists. The caller has already authorized `readBoard` on the project;
 * `includePurpose` must reflect `readRepoFiles`, because the purpose is
 * repository content.
 */
export async function getProjectDirectory(
  projectId: string,
  opts: { includePurpose: boolean },
  client: NodePgDatabase<typeof schema> = getDb() as NodePgDatabase<
    typeof schema
  >,
): Promise<ProjectDirectory | null> {
  const [row] = await client
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      repoPath: projects.repoPath,
      defaultRunnerId: projects.defaultRunnerId,
      brainEnabled: projects.brainEnabled,
    })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!row) return null;

  const [flows, runnerRows, triagerRows, purpose] = await Promise.all([
    listLaunchableFlowSummaries(projectId, client),
    row.defaultRunnerId
      ? client
          .select({
            id: platformAcpRunners.id,
            model: platformAcpRunners.model,
            enabled: platformAcpRunners.enabled,
          })
          .from(platformAcpRunners)
          .where(eq(platformAcpRunners.id, row.defaultRunnerId))
      : Promise.resolve([]),
    client
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .innerJoin(
        agentProjectLinks,
        and(
          eq(agentProjectLinks.agentId, agentSchedules.agentId),
          eq(agentProjectLinks.projectId, agentSchedules.projectId),
          eq(agentProjectLinks.enabled, true),
        ),
      )
      .where(
        and(
          eq(agentSchedules.projectId, projectId),
          eq(agentSchedules.enabled, true),
          eq(agentSchedules.triggerType, "event"),
          sql`${agentSchedules.eventMatch} @> '{"kinds":["task.created"]}'::jsonb`,
        ),
      )
      .limit(1),
    opts.includePurpose ? readReadmePurpose(row.repoPath) : null,
  ]);

  const directory: ProjectDirectory = {
    project: { id: row.id, slug: row.slug, name: row.name },
    purpose,
    launchableFlows: flows,
    defaultRunner: runnerRows[0] ?? null,
    triagerConfigured: triagerRows.length > 0,
    brainEnabled: row.brainEnabled,
    asOf: new Date().toISOString(),
  };

  log.debug(
    {
      projectId,
      flows: flows.length,
      triagerConfigured: directory.triagerConfigured,
      hasPurpose: purpose !== null,
    },
    "project directory",
  );

  return directory;
}
