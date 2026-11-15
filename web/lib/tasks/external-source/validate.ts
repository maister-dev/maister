import type { TaskSource } from "./model";

import { z } from "zod";

// Mirrors the `task_external_sources_shape_check` DB CHECK so the API refuses
// with 422 before the database does (ADR-206).
const HTTPS_URL = /^https:\/\/[^/@\s]+(\/|$)/;

export const taskSourceInputSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    instance: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(
        z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9][a-z0-9._-]*$/),
      ),
    scope: z.string().min(1).max(256),
    externalId: z.string().min(1).max(256),
    externalKey: z.string().min(1).max(64).nullish(),
    url: z.string().max(2048).regex(HTTPS_URL).nullish(),
  })
  .strict();

export type TaskSourceInput = z.input<typeof taskSourceInputSchema>;

export function parseTaskSourceInput(
  raw: unknown,
): { ok: true; value: TaskSource } | { ok: false; message: string } {
  const parsed = taskSourceInputSchema.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid" };
  }

  return {
    ok: true,
    value: {
      ...parsed.data,
      externalKey: parsed.data.externalKey ?? null,
      url: parsed.data.url ?? null,
    },
  };
}
