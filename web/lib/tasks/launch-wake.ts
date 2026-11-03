import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchReceipt } from "./launch-types";

import { after } from "next/server";
import pino from "pino";

import {
  dispatchTaskLaunchIntent,
  reconcileTaskLaunchIntents,
} from "./launch-dispatch";

import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "task-launch-wake",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Next owns the callback lifetime; durable recovery owns a missed or failed wake. */
export function wakeAcceptedTaskLaunch(
  db: Db,
  receipt: TaskLaunchReceipt,
): void {
  if (!["queued", "preparing", "run_bound"].includes(receipt.state)) return;
  after(async () => {
    try {
      await dispatchTaskLaunchIntent(db, receipt.intentId);
    } catch (error) {
      log.error(
        { intentId: receipt.intentId, ...queryErrorDiagnostics(error) },
        "task-launch-wake-failed",
      );
      throw new MaisterError("CRASH", "Accepted launch requires recovery", {
        details: { reason: "launch_wake_failed", intentId: receipt.intentId },
      });
    }
  });
}

/** Cancellation releases capacity after commit; wake the existing bounded queue reconciler. */
export function wakeTaskLaunchQueue(db: Db): void {
  after(async () => {
    try {
      await reconcileTaskLaunchIntents(db);
    } catch (error) {
      log.error(queryErrorDiagnostics(error), "task-launch-queue-wake-failed");
      throw new MaisterError("CRASH", "Task launch queue requires recovery", {
        details: { reason: "launch_queue_wake_failed" },
      });
    }
  });
}
