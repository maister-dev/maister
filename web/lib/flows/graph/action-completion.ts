import type { StepResult } from "../types";
import type { RawNodeOutputPayload } from "./node-output";
import type { Db } from "@/lib/execution-host/db";
import type { CompiledNode } from "./compile";

import { and, eq, isNull } from "drizzle-orm";

import { cliOutputFilePath, readCliOutputFile } from "./node-output";

import { nodeAttempts } from "@/lib/db/schema";
import { nodeOutputMaxBytes } from "@/lib/instance-config";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

/** Immutable action output for the current admitted turn. The attempt stays
 * open until structured-output validation, gates and graph routing finish.
 * A separately authorized turn replaces it only after advancing the ordinal.
 */
export type FlowActionCompletion = Readonly<{
  version: 1;
  commandId: string | null;
  promptOrdinal: number;
  result: Readonly<
    Pick<
      StepResult,
      "ok" | "stdout" | "vars" | "errorCode" | "exitCode" | "acpSessionId"
    >
  >;
  originalOutput: RawNodeOutputPayload;
}>;

/** Capture a local action before gates. Its file channel is read once so
 * continuation does not depend on later workspace contents or run it again.
 */
export async function persistLocalActionCompletion<
  T extends StepResult,
>(input: {
  db: Db;
  runId: string;
  nodeAttemptId: string;
  node: CompiledNode;
  result: T;
  runtimeRoot: string;
  projectSlug: string;
  attempt: number;
}): Promise<T> {
  const originalOutput: RawNodeOutputPayload = input.node.output?.result
    ? await readCliOutputFile(
        cliOutputFilePath({ ...input, nodeId: input.node.id }),
        nodeOutputMaxBytes(),
      )
    : { kind: "absent" };
  const { ok, stdout, vars, errorCode, exitCode, acpSessionId } = input.result;
  const completion: FlowActionCompletion = {
    version: 1,
    commandId: null,
    promptOrdinal: 0,
    result: { ok, stdout, vars, errorCode, exitCode, acpSessionId },
    originalOutput,
  };
  const rows = await input.db
    .update(nodeAttempts)
    .set({ actionCompletion: completion })
    .where(
      and(
        eq(nodeAttempts.id, input.nodeAttemptId),
        eq(nodeAttempts.runId, input.runId),
        eq(nodeAttempts.status, "Running"),
        eq(nodeAttempts.actionPromptOrdinal, 0),
        isNull(nodeAttempts.actionCompletion),
      ),
    )
    .returning({ id: nodeAttempts.id });

  if (rows.length !== 1)
    throw new PromptOwnerInvariantError("local_action_completion_generation");

  return { ...input.result, originalOutput };
}
