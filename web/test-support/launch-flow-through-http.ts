import { randomUUID } from "node:crypto";

import { z } from "zod";

import { poll } from "./durable-workers-ledger";

const previewSchema = z.object({
  settingsToken: z.string().min(1),
  task: z.object({ id: z.string(), revision: z.number().int().nonnegative() }),
});
const receiptSchema = z.object({
  intentId: z.string().min(1),
  taskId: z.string().min(1),
  state: z.string(),
  runId: z.string().nullable(),
  reason: z.string().nullable(),
});

/** Perform one real interactive decision, then wait for its accepted intent to bind. */
export async function launchFlowThroughHttp(
  input: Readonly<{
    api: (route: string, init?: RequestInit) => Promise<Response>;
    origin: string;
    taskId: string;
  }>,
): Promise<string> {
  const previewResponse = await input.api(
    `/api/runs/launch-options?taskId=${encodeURIComponent(input.taskId)}`,
  );

  if (!previewResponse.ok)
    throw new Error(
      `Flow preview failed: ${previewResponse.status}: ${await previewResponse.text()}`,
    );
  const preview = previewSchema.parse(await previewResponse.json());

  if (preview.task.id !== input.taskId)
    throw new Error("Flow preview returned another task");
  const requestKey = randomUUID();
  const response = await input.api("/api/task-launch-intents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: input.origin,
      "Idempotency-Key": requestKey,
    },
    body: JSON.stringify({
      taskId: input.taskId,
      expectedTaskRevision: preview.task.revision,
      expectedSettingsToken: preview.settingsToken,
    }),
  });

  if (response.status !== 202)
    throw new Error(
      `Flow acceptance failed: ${response.status}: ${await response.text()}`,
    );
  const accepted = receiptSchema.parse(await response.json());
  const location = `/api/task-launch-intents/${accepted.intentId}`;

  if (
    response.headers.get("Location") !== location ||
    accepted.taskId !== input.taskId
  )
    throw new Error("Flow acceptance returned another launch identity");

  return poll(
    async () => {
      const currentResponse = await input.api(location);

      if (!currentResponse.ok)
        throw new Error(
          `Flow receipt failed: ${currentResponse.status}: ${await currentResponse.text()}`,
        );
      const current = receiptSchema.parse(await currentResponse.json());

      if (
        current.intentId !== accepted.intentId ||
        current.taskId !== input.taskId
      )
        throw new Error("Flow launch receipt changed identity");
      if (current.runId) return current.runId;
      if (["held", "failed", "cancelled", "settled"].includes(current.state))
        throw new Error(
          `Accepted Flow did not bind: ${current.state}/${current.reason}`,
        );

      return null;
    },
    180_000,
    "accepted Flow intent to bind its Run",
    100,
  );
}
