"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface TaskAgentActionsLabels {
  runAgent: string;
  sendToTriage: string;
  busy: string;
  agentPickerLabel: string;
}

export interface TaskAgentActionsProps {
  slug: string;
  taskId: string;
  taskNumber: number;
  // Attached agents with the `manual` trigger — the "Run agent" candidates.
  agents: Array<{ id: string; name: string }>;
  labels: TaskAgentActionsLabels;
}

// M33 (ADR-088 D11/D13): manual task-bound agent launch + the
// task.triage_requeued emitter trigger ("Send to triage").
export function TaskAgentActions({
  slug,
  taskId,
  taskNumber,
  agents,
  labels,
}: TaskAgentActionsProps): ReactElement {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");

  async function post(url: string, body?: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return;
      }

      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  const buttonClass =
    "inline-flex items-center rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink transition-colors hover:border-amber hover:text-amber disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {agents.length > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          <select
            aria-label={labels.agentPickerLabel}
            className="rounded-md border border-line-soft bg-paper px-2 py-1.5 font-mono text-[10.5px] text-ink outline-none focus:border-amber"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <button
            className={buttonClass}
            disabled={busy || agentId === ""}
            type="button"
            onClick={() =>
              void post(`/api/projects/${slug}/agents/${agentId}/launch`, {
                taskId,
              })
            }
          >
            {busy ? labels.busy : labels.runAgent}
          </button>
        </span>
      ) : null}
      <button
        className={buttonClass}
        disabled={busy}
        type="button"
        onClick={() =>
          void post(`/api/projects/${slug}/tasks/${taskNumber}/send-to-triage`)
        }
      >
        {busy ? labels.busy : labels.sendToTriage}
      </button>
      {error ? (
        <span
          aria-live="polite"
          className="font-mono text-[10.5px] text-danger"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
