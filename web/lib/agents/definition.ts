// Platform-agent definition parsing (ADR-089, package-source rework). The
// canonical definition is `agents/<stem>.md` INSIDE a flow package; the
// platform id is package-qualified `<flowRefId>:<stem>`. This module parses
// frontmatter + body into the typed shape the registry indexes into the
// `agents` table. Parsing NEVER executes definition content.
// Client-import-safe (no fs, no node:*).

import type {
  AgentMode,
  AgentRecommended,
  AgentRiskTier,
  AgentTriggerKind,
  AgentWorkspace,
} from "@/lib/db/schema";

import { z } from "zod";

import { hooksSettingsSchema, type HooksSettings } from "@/lib/config.schema";
import { DOMAIN_EVENT_KINDS } from "@/lib/domain-events/taxonomy";
// errors-core, not @/lib/errors: this module is imported by the client-side
// artifact validator (Studio editor bundle); the server re-export preserves
// class identity so server-side catch/instanceof still works.
import { MaisterError } from "@/lib/errors-core";
import {
  serializeFrontmatter,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";

// One optional `:` separates the package qualifier from the file stem.
export const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;
export const AGENT_STEM_PATTERN = /^[A-Za-z0-9._-]+$/;

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
  .max(192)
  .regex(
    AGENT_ID_PATTERN,
    "agent id must match /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/",
  )
  .refine(
    (s) => !s.split(":").some((part) => part === "." || part === ".."),
    "agent id segments must not be '.' or '..'",
  )
  .refine((s) => !s.includes(".."), "agent id must not contain '..'");

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

export function assertAgentStem(stem: string): string {
  if (!AGENT_STEM_PATTERN.test(stem) || stem === "." || stem.includes("..")) {
    throw new MaisterError(
      "CONFIG",
      `invalid agent file stem "${stem}": must match /^[A-Za-z0-9._-]+$/`,
    );
  }

  return stem;
}

// Compose the platform-unique id from the providing package + file stem.
export function qualifyAgentId(flowRefId: string, stem: string): string {
  return `${flowRefId}:${assertAgentStem(stem)}`;
}

const recommendedSchema = z
  .object({
    runner: z.string().min(1).max(128).optional(),
    cron: z
      .object({
        expr: z.string().min(1).max(128),
        timezone: z.string().min(1).max(64),
      })
      .strict()
      .optional(),
    events: z
      .array(z.enum(DOMAIN_EVENT_KINDS))
      .min(1)
      .refine(
        (kinds) => new Set(kinds).size === kinds.length,
        "recommended events must not repeat",
      )
      .optional(),
  })
  .strict();

// Strict (no passthrough): this schema is MAIster's own contract, not a
// vendor file — unknown keys are refused at registration (ADR-089). The
// pre-rework `scope`/`project` keys are therefore refused loudly too.
export const agentDefinitionFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    runner: z.string().min(1).max(128).optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]),
    // `trigger` resolves the ref from the triggering event (ADR-090 rework);
    // anything else is a literal branch name.
    workspace_ref: z.string().min(1).max(255).optional(),
    mode: z.enum(["session", "subagent"]),
    triggers: z.array(z.enum(AGENT_TRIGGER_KINDS)).min(1),
    capability_profile: z.record(z.unknown()).optional(),
    risk_tier: z.enum(["read_only", "standard", "destructive"]),
    recommended: recommendedSchema.optional(),
    // ADR-104 (M40): explicit per-agent guardrail hooks. Agent runs have no
    // execution-policy preset, so there is no `unattended` auto-arm — only what
    // the agent declares here arms (path_guard / repetition / no_progress).
    hooks: hooksSettingsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
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

    // An ephemeral checkout only exists for repo_read: `none` has no repo
    // context and `worktree` already owns a writable branch checkout.
    if (value.workspace_ref !== undefined && value.workspace !== "repo_read") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspace_ref is only valid with workspace=repo_read",
        path: ["workspace_ref"],
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
  runner: string | null;
  workspace: AgentWorkspace;
  workspaceRef: string | null;
  mode: AgentMode;
  triggers: AgentTriggerKind[];
  capabilityProfile: Record<string, unknown> | null;
  riskTier: AgentRiskTier;
  recommended: AgentRecommended | null;
  hooks: HooksSettings | null;
  prompt: string;
};

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
    runner: fm.runner ?? null,
    workspace: fm.workspace,
    workspaceRef: fm.workspace_ref ?? null,
    mode: fm.mode,
    triggers: fm.triggers,
    capabilityProfile: fm.capability_profile ?? null,
    riskTier: fm.risk_tier,
    recommended: fm.recommended ?? null,
    hooks: fm.hooks ?? null,
    prompt: split.body,
  };
}

export type AgentDefinitionInput = {
  id: string;
  name: string;
  description: string;
  runner?: string | null;
  workspace: AgentWorkspace;
  workspaceRef?: string | null;
  mode: AgentMode;
  triggers: AgentTriggerKind[];
  capabilityProfile?: Record<string, unknown> | null;
  riskTier: AgentRiskTier;
  recommended?: AgentRecommended | null;
  hooks?: HooksSettings | null;
  prompt: string;
};

// Render-then-parse keeps the `.md` the single source: the caller writes the
// rendered file (test fixtures, seeds) and registration re-parses it.
export function renderAgentDefinition(input: AgentDefinitionInput): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    ...(input.runner ? { runner: input.runner } : {}),
    workspace: input.workspace,
    ...(input.workspaceRef ? { workspace_ref: input.workspaceRef } : {}),
    mode: input.mode,
    triggers: input.triggers,
    ...(input.capabilityProfile
      ? { capability_profile: input.capabilityProfile }
      : {}),
    risk_tier: input.riskTier,
    ...(input.recommended ? { recommended: input.recommended } : {}),
    ...(input.hooks ? { hooks: input.hooks } : {}),
  };

  const body = input.prompt.endsWith("\n") ? input.prompt : `${input.prompt}\n`;
  const rendered = serializeFrontmatter({ frontmatter, body });

  // Fail fast on anything that would not survive the round-trip.
  parseAgentDefinition(input.id, rendered);

  return rendered;
}
