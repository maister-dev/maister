"use client";

import type { ProjectExecutor, ProjectFlow } from "@/lib/queries/project";
import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import clsx from "clsx";

export interface NewTaskModalLabels {
  trigger: string;
  title: string;
  titleLabel: string;
  titlePlaceholder: string;
  promptLabel: string;
  promptPlaceholder: string;
  flowLabel: string;
  executorLabel: string;
  executorDefault: string;
  create: string;
  cancel: string;
}

export interface NewTaskModalProps {
  slug: string;
  flows: ProjectFlow[];
  executors: ProjectExecutor[];
  labels: NewTaskModalLabels;
}

export function NewTaskModal({
  slug,
  flows,
  executors,
  labels,
}: NewTaskModalProps): ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [flowId, setFlowId] = useState(flows[0]?.id ?? "");
  const [executorOverrideId, setExecutorOverrideId] = useState("");

  function reset(): void {
    setTitle("");
    setPrompt("");
    setFlowId(flows[0]?.id ?? "");
    setExecutorOverrideId("");
    setError(null);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${slug}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          prompt,
          flowId,
          executorOverrideId: executorOverrideId || undefined,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(data?.code ?? "CRASH");

        return;
      }

      setOpen(false);
      reset();
      startTransition(() => router.refresh());
    } catch {
      setError("EXECUTOR_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }

  const disabled =
    busy ||
    pending ||
    title.trim() === "" ||
    prompt.trim() === "" ||
    flowId === "";

  return (
    <>
      <button
        className="inline-flex items-center gap-1.5 rounded-lg border border-amber bg-amber px-3 py-[7px] font-mono text-[11px] font-semibold tracking-[0.02em] text-white shadow-[0_6px_18px_-8px_var(--amber)] hover:bg-amber-2"
        type="button"
        onClick={() => setOpen(true)}
      >
        <svg
          aria-hidden="true"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
          viewBox="0 0 16 16"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        {labels.trigger}
      </button>

      {open ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <button
            aria-label={labels.cancel}
            className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
            type="button"
            onClick={() => setOpen(false)}
          />
          <div
            aria-modal="true"
            className="relative w-full max-w-[480px] overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
            role="dialog"
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
                {labels.title}
              </h2>
              <button
                aria-label={labels.cancel}
                className="font-mono text-[14px] text-mute hover:text-ink"
                type="button"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-4 px-5 py-5">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                  {labels.titleLabel}
                </span>
                <input
                  className="rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-amber"
                  placeholder={labels.titlePlaceholder}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                  {labels.promptLabel}
                </span>
                <textarea
                  className="min-h-[90px] resize-y rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] leading-[1.5] text-ink outline-none focus:border-amber"
                  placeholder={labels.promptPlaceholder}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                    {labels.flowLabel}
                  </span>
                  <select
                    className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
                    value={flowId}
                    onChange={(e) => setFlowId(e.target.value)}
                  >
                    {flows.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.ref}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
                    {labels.executorLabel}
                  </span>
                  <select
                    className="rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
                    value={executorOverrideId}
                    onChange={(e) => setExecutorOverrideId(e.target.value)}
                  >
                    <option value="">{labels.executorDefault}</option>
                    {executors.map((ex) => (
                      <option key={ex.id} value={ex.id}>
                        {ex.ref}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {error ? (
                <div className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
              <button
                className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
                type="button"
                onClick={() => setOpen(false)}
              >
                {labels.cancel}
              </button>
              <button
                className={clsx(
                  "rounded-lg border border-amber bg-amber px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-white hover:bg-amber-2",
                  disabled && "opacity-60",
                )}
                disabled={disabled}
                type="button"
                onClick={() => void submit()}
              >
                {labels.create}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
