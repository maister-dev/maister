import "server-only";

import type {
  ExecutionHostTransport,
  RuntimeObjectContentStream,
} from "./contracts";

import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "runtime-object-content",
  level: process.env.LOG_LEVEL ?? "info",
});

export const OBJECT_CONTENT_READ_ATTEMPTS = 5;
const BUSY_READ_BACKOFF_MS = 100;

/** Retry only an immutable object GET refused by the host's two-read cap. */
export async function openRuntimeObjectContent(input: {
  transport: ExecutionHostTransport;
  objectId: string;
  context: { eventId: string } | { commandId: string };
  signal: AbortSignal;
}): Promise<RuntimeObjectContentStream> {
  const { transport, objectId, context, signal } = input;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transport.openRuntimeObjectContent(objectId, { signal });
    } catch (error) {
      if (
        signal.aborted ||
        !isMaisterError(error) ||
        error.details?.reason !== "command_in_progress"
      )
        throw error;
      log.warn(
        {
          ...context,
          objectId,
          attempt,
          reason: "command_in_progress",
          exhausted: attempt >= OBJECT_CONTENT_READ_ATTEMPTS,
        },
        "runtime-object-content-read-busy",
      );
      if (attempt >= OBJECT_CONTENT_READ_ATTEMPTS) throw error;
      await delay(BUSY_READ_BACKOFF_MS * attempt, undefined, { signal });
    }
  }
}
