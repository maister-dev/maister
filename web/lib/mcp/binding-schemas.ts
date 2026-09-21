import { z } from "zod";

import { envRefSchema, mcpValueSchema } from "@/lib/mcp/value-grammar";

// ADR-129, amended by ADR-177: request contracts for the project MCP binding
// routes. The overlay replaces the VALUE for a slot the target declares and
// keeps the slot's name, so a remap value uses the SAME `literal | env:NAME`
// grammar as a server value (D32) — one validator for web, supervisor, manifest
// and overlay. `args`/`url` are non-secret overrides; `bearerTokenEnv` is
// `env:NAME` and only for an http/sse target (checked against the target's
// slots). Every schema is `.strict()` so a body cannot smuggle an unknown field.

export const mcpConfigOverlaySchema = z
  .object({
    envRemap: z.record(mcpValueSchema).optional(),
    headerRemap: z.record(mcpValueSchema).optional(),
    bearerTokenEnv: envRefSchema.optional(),
    argsOverride: z.array(z.string()).optional(),
    urlOverride: z.string().url().optional(),
  })
  .strict();

export const targetKindSchema = z.enum(["platform", "project", "package"]);

export const createBindingSchema = z
  .object({
    refId: z.string().min(1),
    targetKind: targetKindSchema,
    targetId: z.string().min(1),
    configOverlay: mcpConfigOverlaySchema.optional(),
  })
  .strict();

export const patchBindingSchema = z
  .object({
    targetKind: targetKindSchema.optional(),
    targetId: z.string().min(1).optional(),
    configOverlay: mcpConfigOverlaySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "empty patch" });

export const connectSchema = z
  .object({
    platformServerId: z.string().min(1),
    refId: z.string().min(1).optional(),
  })
  .strict();

export const disconnectSchema = z.object({ refId: z.string().min(1) }).strict();

// ADR-129 (W-F): probe by bound ref OR an explicit target. NAMES only — no secret.
export const probeSchema = z.union([
  z.object({ refId: z.string().min(1) }).strict(),
  z
    .object({ targetKind: targetKindSchema, targetId: z.string().min(1) })
    .strict(),
]);
