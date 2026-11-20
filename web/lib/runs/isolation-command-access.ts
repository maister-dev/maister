import { z } from "zod";

function uniqueStrings(maxLength: number) {
  return z
    .array(z.string().min(1).max(maxLength))
    .refine((values) => new Set(values).size === values.length, {
      message: "Grant entries must be unique",
    });
}

const boundedPositiveInteger = z.number().int().min(1).max(2147483647);
const grantIds = uniqueStrings(128);

const commandAccessSchema = z.strictObject({
  network: z.strictObject({
    mode: z.enum(["none", "allowlist", "open"]),
    allowedHosts: uniqueStrings(253),
  }),
  hostPortGrants: grantIds,
  readOnlyPathGrants: grantIds,
  writablePathGrants: grantIds,
  limits: z.strictObject({
    timeoutMs: boundedPositiveInteger,
    memoryBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    processes: boundedPositiveInteger,
    cpuMillicores: boundedPositiveInteger,
  }),
});

/** Null clears the override. Omitted top-level fields inherit their defaults. */
export const commandAccessOverrideSchema = commandAccessSchema
  .partial()
  .nullable();
