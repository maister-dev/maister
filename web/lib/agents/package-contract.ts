import "server-only";

import type { ParsedAgentDefinition } from "@/lib/agents/definition";
import type { MaisterPackageManifest } from "@/lib/config.schema";

import { parseDocument } from "yaml";
import { z } from "zod";
import { assertPrivateBoundSessionNames } from "@/lib/capabilities/package-delivery";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseAgentDefinition, qualifyAgentId } from "@/lib/agents/definition";
import {
  TASK_QUALIFICATION_ENGINE_MIN,
  OPERATIONAL_EVIDENCE_CONTRACT,
  OPERATIONAL_EVIDENCE_ENGINE_MIN,
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
  const contract = definition.completion?.contract;
  const minimum =
    contract === OPERATIONAL_EVIDENCE_CONTRACT
      ? OPERATIONAL_EVIDENCE_ENGINE_MIN
      : OPERATIONAL_ENGINE_MIN;

  if (!compat?.engine_min || !semverGte(compat.engine_min, minimum)) {
    throw new MaisterError(
      "CONFIG",
      `agent ${definition.id}: ${contract} requires package compat.engine_min >= ${minimum}`,
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
  const sessionAgents = new Set<string>();
  for (const source of await readPackageAgentSources(root)) {
    const split = splitFrontmatter(source.content);

    if (manifest.delivery && (!split.ok || !split.frontmatter))
      throw new MaisterError(
        "CONFIG",
        `Agent ${source.stem} requires valid frontmatter`,
      );
    if (
      !split.ok ||
      !split.frontmatter ||
      (split.frontmatter.kind === undefined &&
        split.frontmatter.completion === undefined &&
        split.frontmatter.specialist === undefined &&
        !manifest.delivery &&
        !(
          typeof split.frontmatter.capability_profile === "object" &&
          split.frontmatter.capability_profile !== null &&
          "skills" in split.frontmatter.capability_profile
        ))
    )
      continue;
    const definition = parseAgentDefinition(
      qualifyAgentId(manifest.name, source.stem),
      source.content,
    );

    if (definition.mode === "session") sessionAgents.add(definition.id);
    assertOperationalAgentCompatibility(definition, manifest.compat);
    if (manifest.delivery) {
      const declaredMcps = new Set(manifest.mcps.map((mcp) => mcp.id));
      for (const ref of definition.capabilityProfile?.mcps ?? []) {
        if (!declaredMcps.has(ref))
          throw new MaisterError(
            "CONFIG",
            `Agent ${definition.id} references undeclared package MCP ${ref}`,
          );
      }
    }
    for (const skill of definition.capabilityProfile?.skills ?? []) {
      const matches = await Promise.all(
        manifest.capabilities.map(async (bundle) => {
          const entry = join(root, bundle.path, "skills", skill, "SKILL.md");
          try {
            const directory = await lstat(
              join(root, bundle.path, "skills", skill),
            );
            return directory.isDirectory() && (await lstat(entry)).isFile();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return false;
            throw error;
          }
        }),
      );
      if (matches.filter(Boolean).length !== 1)
        throw new MaisterError(
          "CONFIG",
          `Agent ${definition.id} must select one unambiguous packaged skill: ${skill}`,
        );
    }
  }
  if (manifest.delivery && sessionAgents.size)
    for (const flow of manifest.flows) {
      const file = join(root, flow.path, "flow.yaml");
      const doc = parseDocument(await readFile(file, "utf8"));
      if (doc.errors.length)
        throw new MaisterError(
          "CONFIG",
          `Invalid Flow ${flow.id} for agent session validation`,
        );
      const parsed = z
        .object({
          nodes: z.array(
            z.object({
              id: z.string(),
              session: z.string().optional(),
              settings: z.unknown().optional(),
            }),
          ),
        })
        .safeParse(doc.toJS());
      if (!parsed.success) continue;
      const bound = new Set(
        parsed.data.nodes
          .filter((n) => {
            const settings = z
              .object({ agent: z.string() })
              .safeParse(n.settings);
            return settings.success && sessionAgents.has(settings.data.agent);
          })
          .map((n) => n.id),
      );
      assertPrivateBoundSessionNames(parsed.data.nodes, bound);
    }
}
