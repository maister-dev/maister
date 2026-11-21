import { z } from "zod";

export const workspaceIntegrityFields = {
  maxSizeMiB: {
    max: 8192,
    defaultValue: 1024,
    env: "MAISTER_WORKSPACE_INTEGRITY_MAX_SIZE_MIB",
    anchor: "workspace-integrity-size",
  },
  maxDurationSeconds: {
    max: 240,
    defaultValue: 120,
    env: "MAISTER_WORKSPACE_INTEGRITY_MAX_DURATION_SECONDS",
    anchor: "workspace-integrity-duration",
  },
  maxEntries: {
    max: 500000,
    defaultValue: 100000,
    env: "MAISTER_WORKSPACE_INTEGRITY_MAX_ENTRIES",
    anchor: "workspace-integrity-entries",
  },
} as const;

export type IntegrityField = keyof typeof workspaceIntegrityFields;
export type IntegritySource = "platform" | "environment" | "default";
export type IntegritySettings = Record<
  IntegrityField,
  { value: number; source: IntegritySource }
>;

export const workspaceIntegrityFieldNames = Object.keys(
  workspaceIntegrityFields,
) as IntegrityField[];

export function integrityValueSchema(field: IntegrityField) {
  return z.number().int().min(1).max(workspaceIntegrityFields[field].max);
}

export const integrityPatchSchema = z
  .strictObject({
    maxSizeMiB: integrityValueSchema("maxSizeMiB").nullable().optional(),
    maxDurationSeconds: integrityValueSchema("maxDurationSeconds")
      .nullable()
      .optional(),
    maxEntries: integrityValueSchema("maxEntries").nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined));

export type IntegrityPatch = z.infer<typeof integrityPatchSchema>;
