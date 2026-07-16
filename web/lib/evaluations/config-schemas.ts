// Client-safe (no `server-only`): request validation + DTO projections shared by
// the admin evaluation-config routes. Panels/Profiles carry no secrets — the
// role bindings reference package-qualified agent ids and runner intent only.

import { z } from "zod";

const roleBindingSchema = z
  .object({
    role: z.string().trim().min(1).max(64),
    agentId: z.string().trim().min(1).max(256),
    runnerId: z.string().trim().min(1).nullable().optional(),
    runnerIntent: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const panelPolicySchema = z
  .object({
    attempts: z.number().int().min(1).max(64),
    maxParallelAttempts: z.number().int().min(1).max(64),
    quorum: z.number().int().min(1).max(64),
    timeoutMs: z.number().int().positive().max(3_600_000),
    maxRetries: z.number().int().min(0).max(16),
    budgets: z
      .object({
        tokens: z.number().int().positive().nullable().optional(),
        costUsd: z.number().positive().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    blindLabels: z.boolean(),
    randomizeOrder: z.boolean(),
    allowedMcps: z.array(z.string().trim().min(1)).max(64),
    poisonPolicy: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  // quorum can never exceed the total independent attempts (D8/D12 structural
  // invariant enforced at the config boundary, not only at resolution).
  .refine((p) => p.quorum <= p.attempts, {
    message: "quorum must not exceed attempts",
    path: ["quorum"],
  });

export const createPanelBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    roleBindings: z.array(roleBindingSchema).min(1).max(32),
    policy: panelPolicySchema,
  })
  .strict();

export const patchPanelBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    roleBindings: z.array(roleBindingSchema).min(1).max(32).optional(),
    policy: panelPolicySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "no fields to update",
  });

const boundSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

// Allowed-override entry: `true` (any value) or an inclusive numeric bound.
const allowedOverridesSchema = z.record(
  z.string(),
  z.union([z.literal(true), boundSchema]),
);
const hardLimitsSchema = z.record(z.string(), boundSchema);

export const createProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    methodRevisionId: z.string().trim().min(1),
    panelId: z.string().trim().min(1),
    defaults: z.record(z.string(), z.unknown()).nullable().optional(),
    hardLimits: hardLimitsSchema.nullable().optional(),
    allowedOverrides: allowedOverridesSchema.nullable().optional(),
  })
  .strict();

export const patchProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    defaults: z.record(z.string(), z.unknown()).nullable().optional(),
    hardLimits: hardLimitsSchema.nullable().optional(),
    allowedOverrides: allowedOverridesSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "no fields to update",
  });

export const putOverrideBodySchema = z
  .object({
    overrides: z.record(z.string(), z.union([z.number(), z.boolean()])),
  })
  .strict();

// --- DTO projections (explicit, no raw rows cross the boundary) --------------

export interface JudgePanelDto {
  id: string;
  name: string;
  revision: number;
  roleBindings: unknown;
  policy: unknown;
  enabled: boolean;
  updatedAt: string | null;
}

export function toJudgePanelDto(row: Record<string, unknown>): JudgePanelDto {
  return {
    id: row.id as string,
    name: row.name as string,
    revision: row.revision as number,
    roleBindings: row.roleBindings,
    policy: row.policy,
    enabled: row.enabled as boolean,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
  };
}

export interface EvaluationProfileDto {
  id: string;
  name: string;
  revision: number;
  methodRevisionId: string;
  panelId: string;
  defaults: unknown;
  hardLimits: unknown;
  allowedOverrides: unknown;
  enabled: boolean;
  updatedAt: string | null;
}

export function toEvaluationProfileDto(
  row: Record<string, unknown>,
): EvaluationProfileDto {
  return {
    id: row.id as string,
    name: row.name as string,
    revision: row.revision as number,
    methodRevisionId: row.methodRevisionId as string,
    panelId: row.panelId as string,
    defaults: row.defaults ?? null,
    hardLimits: row.hardLimits ?? null,
    allowedOverrides: row.allowedOverrides ?? null,
    enabled: row.enabled as boolean,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
  };
}
