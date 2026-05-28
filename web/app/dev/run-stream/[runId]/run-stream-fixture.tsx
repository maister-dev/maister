"use client";

import { useRunStream } from "@/lib/use-run-stream";

export function RunStreamFixture({ runId }: { runId: string }) {
  const { events, status, lastEventId, error, reconnect } = useRunStream(runId);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm font-mono">
        <span>status: {status}</span>
        <span>lastEventId: {lastEventId ?? "—"}</span>
        <span>events: {events.length}</span>
        {error ? <span className="text-red-500">error: {error}</span> : null}
        <button
          onClick={reconnect}
          className="ml-auto px-2 py-1 border rounded text-xs"
          type="button"
        >
          reconnect
        </button>
      </div>
      <pre className="text-xs font-mono bg-black/5 dark:bg-white/5 p-3 rounded max-h-[60vh] overflow-auto">
        {events.length === 0
          ? "(no events yet)"
          : events.map((e, i) => `${i}: ${JSON.stringify(e)}`).join("\n")}
      </pre>
    </div>
  );
}
