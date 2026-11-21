import "server-only";

import type { WaitJson } from "@/lib/waits/contracts";

import Ajv, { type AnySchema } from "ajv";

import { MaisterError } from "@/lib/errors";

const validator = new Ajv({
  strict: true,
  allErrors: false,
  ownProperties: true,
  addUsedSchema: false,
});

export function compileWaitPayloadSchema(
  schema: boolean | Record<string, WaitJson>,
) {
  try {
    return validator.compile(schema as AnySchema);
  } catch (error: unknown) {
    throw new MaisterError("CONFIG", "Invalid wait payload_schema", {
      details: { reason: "wait_invalid_payload_schema" },
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    if (typeof schema === "object") validator.removeSchema(schema as AnySchema);
  }
}
