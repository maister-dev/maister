// Client-safe (NO `server-only`): both the editor (the lenient warning) and the
// server commit gate (validate.ts) validate capability subagents with this.
import { z } from "zod";

import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";

// (M39 A4) Capability subagents (`capability/<id>/agents/<stem>.md`) are Claude
// subagents — materialized into `.claude/agents/` at run, NOT platform agents.
// The schema is LENIENT + OPEN: the known Claude-Code fields are typed; every
// other key is PRESERVED (`.passthrough()`) — contrast the STRICT platform-agent
// `agentDefinitionFrontmatterSchema` (unknown key → CONFIG). `tools` is a CSV
// string or a list; `model`/`color` are free strings.
export const subagentFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    tools: z.union([z.string(), z.array(z.string())]).optional(),
    model: z.string().optional(),
    color: z.string().optional(),
  })
  .passthrough();

export type SubagentFrontmatter = z.infer<typeof subagentFrontmatterSchema>;

// The New-Subagent template body. `model: inherit` — the runner is
// non-deterministic, so NEVER hard-code a model (e.g. sonnet); `tools` is
// omitted so the subagent inherits all tools.
export function newSubagentTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: \nmodel: inherit\n---\n`;
}

// Lenient validation of a subagent `.md` (frontmatter only). Returns issue
// strings (NEVER throws); empty = valid. Mirrors the skill/manifest validators.
export function validateSubagentMarkdown(content: string): string[] {
  const split = splitFrontmatter(content);

  if (!split.ok || split.frontmatter === undefined) {
    return [
      "subagent .md has missing or unparseable frontmatter (a leading `---` yaml block with name + description is required).",
    ];
  }

  const result = subagentFrontmatterSchema.safeParse(split.frontmatter);

  if (result.success) return [];

  return result.error.issues.map(
    (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
  );
}
