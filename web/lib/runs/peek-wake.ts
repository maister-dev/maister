import "server-only";

import type { Client, Notification } from "pg";

import pino from "pino";
import { z } from "zod";

import {
  createDbNotificationClient,
  registerDbShutdown,
} from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "run-peek-listener",
  level: process.env.LOG_LEVEL ?? "info",
});
const hintSchema = z
  .object({
    source: z.enum([
      "runs",
      "run_results",
      "workspaces",
      "execution_events",
      "node_attempts",
      "run_messages",
    ]),
    topic: z.enum(["summary", "execution", "transcript"]),
    runId: z.string().min(1).max(256),
    parentRunId: z.string().nullable(),
    previousParentRunId: z.string().nullable(),
    rootRunId: z.string().nullable(),
  })
  .strict();

export type PeekHint = z.infer<typeof hintSchema>;
type Subscriber = { notify: (hint: PeekHint) => void; lost: () => void };
type Hub = {
  client: Client | null;
  starting: Promise<void> | null;
  subscribers: Set<Subscriber>;
  unregister: (() => void) | null;
};
const processState = globalThis as typeof globalThis & { maisterPeekHub?: Hub };
const hub: Hub = (processState.maisterPeekHub ??= {
  client: null,
  starting: null,
  subscribers: new Set(),
  unregister: null,
});

async function closeListener(): Promise<void> {
  const client = hub.client;

  hub.client = null;
  hub.unregister?.();
  hub.unregister = null;
  if (client) {
    await client.end();
    log.info({ subscribers: hub.subscribers.size }, "peek listener stopped");
  }
}

function loseListener(client: Client, error: unknown): void {
  if (hub.client !== client) return;
  hub.client = null;
  hub.unregister?.();
  hub.unregister = null;
  log.warn(
    { err: error, subscribers: hub.subscribers.size },
    "peek listener disconnected",
  );
  for (const subscriber of [...hub.subscribers]) subscriber.lost();
  void client
    .end()
    .catch((err: unknown) => log.error({ err }, "peek listener close failed"));
}

function deliver(notification: Notification): void {
  const parsed = hintSchema.safeParse(
    notification.payload ? parseHint(notification.payload) : null,
  );

  if (!parsed.success) {
    const client = hub.client;

    if (client)
      loseListener(
        client,
        new MaisterError("ACP_PROTOCOL", "Invalid peek notification"),
      );

    return;
  }
  for (const subscriber of [...hub.subscribers]) subscriber.notify(parsed.data);
}
function parseHint(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

async function startListener(): Promise<void> {
  const client = await createDbNotificationClient();

  client.on("error", (error) => loseListener(client, error));
  client.on("end", () =>
    loseListener(
      client,
      new MaisterError("EXECUTOR_UNAVAILABLE", "Peek listener ended"),
    ),
  );
  client.on("notification", (notification) => {
    if (hub.client === client) deliver(notification);
  });
  try {
    await client.connect();
    // Register first. Canonical ready reloads repair anything committed before LISTEN.
    await client.query("LISTEN maister_run_peek");
    const catalog = await client.query<{
      indexes: number;
      triggers: number;
    }>(`SELECT
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname=ANY(ARRAY['run_messages_peek_node_order_idx','run_messages_peek_run_order_idx','runs_peek_parent_launch_idx'])) AS indexes,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D' AND tgname=ANY(ARRAY['runs_peek_hint','run_results_peek_hint','workspaces_peek_hint','execution_events_peek_hint','node_attempts_peek_hint','run_messages_peek_hint'])) AS triggers`);

    if (catalog.rows[0]?.indexes !== 3 || catalog.rows[0]?.triggers !== 6)
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "Peek database upgrade is incomplete",
        { details: { reason: "peek_catalog_missing" } },
      );
    hub.client = client;
    hub.unregister = registerDbShutdown(async () => {
      for (const subscriber of [...hub.subscribers]) subscriber.lost();
      await closeListener();
    });
    log.info({ subscribers: hub.subscribers.size }, "peek listener ready");
  } catch (cause) {
    await client.end();
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Peek change listener unavailable",
      { cause },
    );
  }
}

/** One autocommit LISTEN connection per process, shared until the last owner leaves. */
export async function subscribePeekChanges(
  notify: Subscriber["notify"],
  lost: Subscriber["lost"],
): Promise<() => Promise<void>> {
  const subscriber = { notify, lost };

  hub.subscribers.add(subscriber);
  try {
    if (!hub.client) {
      if (!hub.starting)
        hub.starting = startListener().finally(() => {
          hub.starting = null;
        });
      await hub.starting;
    }
  } catch (error) {
    hub.subscribers.delete(subscriber);
    throw error;
  }
  let released = false;

  return async () => {
    if (released) return;
    released = true;
    hub.subscribers.delete(subscriber);
    if (hub.subscribers.size === 0) await closeListener();
  };
}
