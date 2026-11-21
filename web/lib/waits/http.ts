import "server-only";

import type { WaitJson } from "@/lib/waits/contracts";

import { z } from "zod";

import {
  canonicalCommandJson,
  CommandJsonError,
} from "../../../runtime/command-json";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((key) => !key.includes("\0"));

export const waitSignalBody = z.strictObject({
  name: z.string().min(1).max(128),
  outcome: z.string().min(1).max(64),
  headSha: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .optional(),
  payload: z
    .custom<WaitJson>((value) => {
      try {
        canonicalCommandJson(value);

        return true;
      } catch (error: unknown) {
        if (error instanceof CommandJsonError) return false;
        throw error;
      }
    })
    .optional(),
});

export async function readWaitCommand<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ key: string; body: T }> {
  const value = await readBoundedJson(request, 32 * 1024);
  const key = keySchema.safeParse(request.headers.get("idempotency-key"));
  const body = schema.safeParse(value);

  if (!key.success || !body.success)
    throw new MaisterError("CONFIG", "Invalid wait request", {
      details: { reason: "wait_invalid_payload" },
    });

  return { key: key.data, body: body.data };
}

export function waitHttpError(error: unknown, route: string) {
  if (isMaisterError(error)) {
    const reason = error.details?.reason;

    if (reason === "wait_not_found")
      return privateJson({ code: "NOT_FOUND", message: "Wait not found" }, 404);
    if (reason === "wait_invalid_payload")
      return privateJson(
        { code: "CONFIG", message: error.message, details: { reason } },
        422,
      );
  }

  return privateErrorResponse(error, route);
}
