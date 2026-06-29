import "server-only";

import { open, readFile } from "node:fs/promises";

// A non-agent gate (human / form / review / infra_recovery) transitions a run to
// NeedsInput with NO supervisor session running, so nothing appends to
// `run.events.jsonl` and an open run-detail tab never gets an SSE tick to pull
// the freshly-rendered review panel — the run looks hung until a manual reload.
//
// This appends one durable transition event to the per-run events log so the SSE
// tail (`/api/runs/[id]/stream`) emits a tick AFTER the NeedsInput commit. The
// `monotonicId` is sourced from the current file max + 1, matching the
// supervisor's own `tailMaxMonotonicId` seeding (supervisor/src/spawn.ts) — the
// next spawned session re-seeds above this value, so there is no id collision.
// Safe to call only when no supervisor session is concurrently writing this file
// (true for non-agent gates, whose prior agent session has already exited).
export async function appendRunStreamEvent(
  eventsLogPath: string,
  event: { type: string; data?: Record<string, unknown> },
): Promise<number> {
  let max = 0;

  try {
    const raw = await readFile(eventsLogPath, "utf8");

    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;

      try {
        const id = (JSON.parse(line) as { monotonicId?: unknown }).monotonicId;

        if (typeof id === "number" && id > max) max = id;
      } catch {
        /* skip malformed line — mirrors the SSE tail's tolerance */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const monotonicId = max + 1;
  const line = `${JSON.stringify({
    type: event.type,
    monotonicId,
    ...event.data,
    sessionName: "default",
  })}\n`;

  const handle = await open(eventsLogPath, "a");

  try {
    await handle.write(line);
  } finally {
    await handle.close();
  }

  return monotonicId;
}
