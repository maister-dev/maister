import { z } from "zod";

// ADR-129: request contracts for the project MCP binding routes. The overlay
// carries NAME-only remaps (env:NAME); args/url are non-secret overrides. Every
// schema is `.strict()` so a body cannot smuggle an unknown field.

const envRef = z
  .string()
  .regex(
    /^env:[A-Za-z_][A-Za-z0-9_]*$/,
    "secret must be env:NAME, not a value",
  );

export const mcpConfigOverlaySchema = z
  .object({
    envRemap: z.record(envRef).optional(),
    headerRemap: z.record(envRef).optional(),
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
