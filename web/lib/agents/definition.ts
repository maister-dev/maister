// Platform-agent definition parsing (ADR-088). The `.md` in the host catalog
// is the canonical source; this module parses frontmatter + body into the
// typed shape the registry indexes into the `agents` table. Parsing NEVER
// executes definition content. Client-import-safe (no fs, no node:*).

import type {
  AgentMode,
  AgentRiskTier,
  AgentScope,
  AgentTriggerKind,
  AgentWorkspace,
} from "@/lib/db/schema";

import { z } from "zod";

import { MaisterError } from "@/lib/errors";
import {
  serializeFrontmatter,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";

export const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const AGENT_TRIGGER_KINDS = [
  "manual",
  "cron",
  "domain_event",
  "webhook",
  "flow",
] as const;

const agentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(AGENT_ID_PATTERN, "agent id must match /^[A-Za-z0-9._-]+$/")
  .refine(
    (s) => s !== "." && s !== ".." && !s.includes(".."),
    "agent id must not be '.', '..' or contain '..'",
  );

// Strict (no passthrough): this schema is MAIster's own contract, not a
// vendor file — unknown keys are refused at registration (ADR-088).
export const agentDefinitionFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    scope: z.enum(["platform", "project"]),
    project: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "project must be a kebab-case slug")
      .optional(),
    runner: z.string().min(1).max(128).optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]),
    mode: z.enum(["session", "subagent"]),
    triggers: z.array(z.enum(AGENT_TRIGGER_KINDS)).min(1),
    capability_profile: z.record(z.unknown()).optional(),
    risk_tier: z.enum(["read_only", "standard", "destructive"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.scope === "project") !== (value.project !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          value.scope === "project"
            ? "scope=project requires a `project` slug"
            : "`project` is only valid with scope=project",
        path: ["project"],
      });
    }

    if (new Set(value.triggers).size !== value.triggers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "triggers must not repeat",
        path: ["triggers"],
      });
    }

    // Standalone triggers require an own ACP session; a subagent definition
    // is materialized into a host run's worktree and can only be flow-bound.
    if (value.mode === "subagent" && value.triggers.some((t) => t !== "flow")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mode=subagent allows only the `flow` trigger",
        path: ["triggers"],
      });
    }
  });

export type AgentDefinitionFrontmatter = z.infer<
  typeof agentDefinitionFrontmatterSchema
>;

export type ParsedAgentDefinition = {
  id: string;
  name: string;
  description: string;
  scope: AgentScope;
  projectSlug: string | null;
  runner: string | null;
  workspace: AgentWorkspace;
  mode: AgentMode;
  triggers: AgentTriggerKind[];
  capabilityProfile: Record<string, unknown> | null;
  riskTier: AgentRiskTier;
  prompt: string;
};

export function assertAgentId(id: string): string {
  const parsed = agentIdSchema.safeParse(id);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      `invalid agent id "${id}": ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  return parsed.data;
}

export function parseAgentDefinition(
  id: string,
  content: string,
): ParsedAgentDefinition {
  assertAgentId(id);

  const split = splitFrontmatter(content);

  if (!split.ok) {
    throw new MaisterError(
      "CONFIG",
      `agent "${id}": malformed frontmatter — ${split.reason}`,
    );
  }

  if (!split.frontmatter) {
    throw new MaisterError(
      "CONFIG",
      `agent "${id}": missing frontmatter block`,
    );
  }

  const parsed = agentDefinitionFrontmatterSchema.safeParse(split.frontmatter);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`)
      .join("; ");

    throw new MaisterError("CONFIG", `agent "${id}": ${detail}`);
  }

  const prompt = split.body.trim();

  if (prompt.length === 0) {
    throw new MaisterError(
      "CONFIG",
      `agent "${id}": body prompt must not be empty`,
    );
  }

  const fm = parsed.data;

  return {
    id,
    name: fm.name,
    description: fm.description,
    scope: fm.scope,
    projectSlug: fm.project ?? null,
    runner: fm.runner ?? null,
    workspace: fm.workspace,
    mode: fm.mode,
    triggers: fm.triggers,
    capabilityProfile: fm.capability_profile ?? null,
    riskTier: fm.risk_tier,
    prompt: split.body,
  };
}

export type AgentDefinitionInput = {
  id: string;
  name: string;
  description: string;
  scope: AgentScope;
  project?: string | null;
  runner?: string | null;
  workspace: AgentWorkspace;
  mode: AgentMode;
  triggers: AgentTriggerKind[];
  capabilityProfile?: Record<string, unknown> | null;
  riskTier: AgentRiskTier;
  prompt: string;
};

// Render-then-parse keeps the `.md` the single source: the caller writes the
// rendered file and registration re-parses it from disk.
export function renderAgentDefinition(input: AgentDefinitionInput): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    scope: input.scope,
    ...(input.project ? { project: input.project } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
    workspace: input.workspace,
    mode: input.mode,
    triggers: input.triggers,
    ...(input.capabilityProfile
      ? { capability_profile: input.capabilityProfile }
      : {}),
    risk_tier: input.riskTier,
  };

  const body = input.prompt.endsWith("\n") ? input.prompt : `${input.prompt}\n`;
  const rendered = serializeFrontmatter({ frontmatter, body });

  // Fail fast on anything that would not survive the round-trip.
  parseAgentDefinition(input.id, rendered);

  return rendered;
}
