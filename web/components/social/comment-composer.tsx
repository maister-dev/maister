"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CommentComposerLabels {
  placeholder: string;
  submit: string;
  submitting: string;
  hint: string;
  errorConfig: string;
  errorForbidden: string;
  errorGeneric: string;
}

export function CommentComposer({
  slug,
  taskNumber,
  labels,
}: {
  slug: string;
  taskNumber: number;
  labels: CommentComposerLabels;
}): ReactElement {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy || body.trim().length === 0) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${slug}/tasks/${taskNumber}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(
          payload?.code === "CONFIG"
            ? labels.errorConfig
            : payload?.code === "UNAUTHORIZED"
              ? labels.errorForbidden
              : labels.errorGeneric,
        );

        return;
      }

      setBody("");
      router.refresh();
    } catch {
      setError(labels.errorGeneric);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor="task-comment-body">
        {labels.placeholder}
      </label>
      <textarea
        className="min-h-[88px] w-full rounded-lg border border-line bg-paper p-3 text-[13px] leading-[1.6] text-ink outline-none transition focus:border-amber"
        disabled={busy}
        id="task-comment-body"
        maxLength={10_000}
        placeholder={labels.placeholder}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-mute">{labels.hint}</span>
        <button
          className="rounded-lg border border-amber bg-amber-soft px-3 py-1.5 text-[12px] font-semibold text-amber transition hover:bg-amber/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || body.trim().length === 0}
          type="button"
          onClick={() => void submit()}
        >
          {busy ? labels.submitting : labels.submit}
        </button>
      </div>
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
