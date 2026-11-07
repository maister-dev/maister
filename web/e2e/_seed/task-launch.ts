import type { Response } from "@playwright/test";
import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";

import { expect } from "@playwright/test";

import { singleValue } from "./db";

type TaskLaunchBinding = Readonly<{
  intentId: string;
  taskId: string;
  state: string;
  reason: string | null;
  runId: string | null;
  runTaskId: string | null;
  runIntentId: string | null;
}>;

/** A browser decision accepts one intent; its nullable Run is not evidence of model dispatch. */
export async function readTaskLaunchReceipt(
  response: Response,
): Promise<TaskLaunchReceipt> {
  expect(new URL(response.url()).pathname).toBe("/api/task-launch-intents");
  expect(response.request().method()).toBe("POST");
  expect(response.status()).toBe(202);
  const request: Readonly<{ taskId?: unknown }> = response
    .request()
    .postDataJSON();
  const receipt: TaskLaunchReceipt = await response.json();

  expect(typeof request.taskId).toBe("string");
  expect(receipt).toMatchObject({
    schemaVersion: 1,
    intentId: expect.any(String),
    taskId: request.taskId,
    basis: "manual",
    stateVersion: expect.any(Number),
    settingsDigest: expect.any(String),
  });
  expect(response.headers().location).toBe(
    `/api/task-launch-intents/${receipt.intentId}`,
  );

  return receipt;
}

/** Runtime scenarios follow the exact durable association, never the latest Run of a task. */
export async function waitForTaskLaunchRun(
  receipt: TaskLaunchReceipt,
): Promise<string> {
  const load = (): Promise<TaskLaunchBinding | null> =>
    singleValue<TaskLaunchBinding>(
      `SELECT json_build_object(
       'intentId', i.id, 'taskId', i.task_id, 'state', i.state, 'reason', i.reason,
       'runId', i.run_id, 'runTaskId', r.task_id, 'runIntentId', r.task_launch_intent_id
     ) AS value FROM task_launch_intents i
     LEFT JOIN runs r ON r.id=i.run_id WHERE i.id=$1`,
      [receipt.intentId],
    );
  const expected = {
    intentId: receipt.intentId,
    taskId: receipt.taskId,
    runId: expect.any(String),
    runTaskId: receipt.taskId,
    runIntentId: receipt.intentId,
  };

  await expect.poll(load, { timeout: 30_000 }).toMatchObject(expected);
  const binding = await load();

  expect(binding).toMatchObject(expected);
  if (!binding?.runId) throw new Error("Accepted task launch has no bound Run");

  return binding.runId;
}
