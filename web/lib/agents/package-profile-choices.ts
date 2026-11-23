import { parseDocument } from "yaml";

import { maisterPackageManifestSchema } from "@/lib/config.schema";
import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

export type AgentPackageChoices = {
  skills: readonly string[];
  mcps: readonly string[];
};

/** A picker can only offer references the current draft could supply after a cut. */
export function packageProfileChoices(
  files: readonly AuthoredFlowPackageFile[],
): AgentPackageChoices | undefined {
  const source = files.find((file) => file.path === "maister-package.yaml");
  if (!source) return undefined;
  const doc = parseDocument(source.content);
  if (doc.errors.length) return undefined;
  const manifest = maisterPackageManifestSchema.safeParse(doc.toJS());
  if (!manifest.success) return undefined;
  const skills = new Set<string>();
  for (const bundle of manifest.data.capabilities) {
    const prefix = bundle.path + "/skills/";
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const [slug, name, ...rest] = file.path.slice(prefix.length).split("/");
      if (slug && name === "SKILL.md" && !rest.length) skills.add(slug);
    }
  }
  return {
    skills: [...skills].sort(),
    mcps: manifest.data.mcps.map((mcp) => mcp.id).sort(),
  };
}
