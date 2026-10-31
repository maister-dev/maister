import "server-only";

import type { ParsedAgentDefinition } from "@/lib/agents/definition";
import type { MaisterPackageManifest } from "@/lib/config.schema";

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseAgentDefinition, qualifyAgentId } from "@/lib/agents/definition";
import {
  TASK_QUALIFICATION_ENGINE_MIN,
  OPERATIONAL_ENGINE_MIN,
} from "@/lib/agents/kind";
import { MaisterError } from "@/lib/errors";
import { isEngineCompatible } from "@/lib/flows/engine-version";
import { semverGte } from "@/lib/flows/semver";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";

export function assertOperationalAgentCompatibility(
  definition: ParsedAgentDefinition,
  compat: MaisterPackageManifest["compat"],
): void {
  if (definition.kind !== "operational") return;
  if (
    !compat?.engine_min ||
    !semverGte(compat.engine_min, OPERATIONAL_ENGINE_MIN)
  ) {
    throw new MaisterError(
      "CONFIG",
      `agent ${definition.id}: operational_v1 requires package compat.engine_min >= ${OPERATIONAL_ENGINE_MIN}`,
    );
  }
  if (
    definition.taskQualification &&
    !semverGte(compat.engine_min, TASK_QUALIFICATION_ENGINE_MIN)
  )
    throw new MaisterError(
      "CONFIG",
      `agent ${definition.id}: task qualification requires package compat.engine_min >= ${TASK_QUALIFICATION_ENGINE_MIN}`,
    );
  const range = isEngineCompatible(compat.engine_min, compat.engine_max);

  if (!range.compatible)
    throw new MaisterError(
      "CONFIG",
      `agent ${definition.id}: incompatible package: ${range.reason}`,
    );
}

export async function readPackageAgentSources(
  root: string,
): Promise<Array<{ stem: string; path: string; content: string }>> {
  const directory = join(root, "maister-agents");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      throw error;
    },
  );
  const sources: Array<{ stem: string; path: string; content: string }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile())
      throw new MaisterError(
        "CONFIG",
        `agent definition must be a regular file: ${join(directory, entry.name)}`,
      );
    const path = join(directory, entry.name);

    sources.push({
      stem: entry.name.slice(0, -3),
      path,
      content: await readFile(path, "utf8"),
    });
  }

  return sources;
}

/** Old report-only definitions keep registry behavior; explicit new axes fail fast. */
export async function assertPackageOperationalContracts(
  root: string,
  manifest: MaisterPackageManifest,
): Promise<void> {
  if (manifest.compat) {
    const range = isEngineCompatible(
      manifest.compat.engine_min,
      manifest.compat.engine_max,
    );

    if (!range.compatible)
      throw new MaisterError(
        "CONFIG",
        `package ${manifest.name}: ${range.reason}`,
      );
  }
  for (const source of await readPackageAgentSources(root)) {
    const split = splitFrontmatter(source.content);

    if (
      !split.ok ||
      !split.frontmatter ||
      (split.frontmatter.kind === undefined &&
        split.frontmatter.completion === undefined)
    )
      continue;
    const definition = parseAgentDefinition(
      qualifyAgentId(manifest.name, source.stem),
      source.content,
    );

    assertOperationalAgentCompatibility(definition, manifest.compat);
  }
}
