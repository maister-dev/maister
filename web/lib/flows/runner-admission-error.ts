import "server-only";

import pino from "pino";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "flow-runner-admission",
  level: process.env.LOG_LEVEL ?? "info",
});

export function runnerAdmissionError(input: {
  readonly taskId: string;
  readonly projectId: string;
  readonly slotKey: string;
  readonly label: string;
  readonly error: MaisterError;
}): MaisterError {
  log.warn(
    {
      taskId: input.taskId,
      projectId: input.projectId,
      slotKey: input.slotKey,
      err: input.error,
    },
    "flow runner admission refused before workspace creation",
  );

  return new MaisterError(input.error.code, input.error.message, {
    cause: input.error,
    details: {
      reason: "flow_runner_unresolved",
      slotKey: input.slotKey,
      label: input.label,
    },
  });
}
