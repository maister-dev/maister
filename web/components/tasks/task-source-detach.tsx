"use client";

import type { ReactElement } from "react";

import { LinkSlashIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/feedback/confirm-dialog";

export type TaskSourceDetachLabels = {
  detach: string;
  title: string;
  body: string;
  cancel: string;
  confirm: string;
  detaching: string;
  error: string;
};

// ADR-206: the audited human detach. Freeing the identity lets a later import
// create a second task for the same external item, so it asks first.
export function TaskSourceDetach({
  slug,
  taskNumber,
  labels,
}: {
  slug: string;
  taskNumber: number;
  labels: TaskSourceDetachLabels;
}): ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();

  function close(): void {
    setOpen(false);
    setFailed(false);
  }

  async function detach(): Promise<void> {
    setBusy(true);
    setFailed(false);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/tasks/${taskNumber}/source`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        setFailed(true);

        return;
      }

      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        aria-label={labels.detach}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-mute transition-colors hover:text-danger"
        data-testid="task-source-detach"
        title={labels.detach}
        type="button"
        onClick={() => setOpen(true)}
      >
        <LinkSlashIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <ConfirmDialog
          body={labels.body}
          busy={busy}
          cancelLabel={labels.cancel}
          testId="task-source-detach-confirm"
          title={labels.title}
          titleId="task-source-detach-title"
          onClose={close}
        >
          {failed ? (
            <p
              aria-live="assertive"
              className="rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
              role="alert"
            >
              {labels.error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-lg border border-line bg-paper px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.02em] text-mute hover:border-mute hover:text-ink-2"
              disabled={busy}
              type="button"
              onClick={close}
            >
              {labels.cancel}
            </button>
            <button
              className="rounded-lg border border-danger bg-paper px-3.5 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-danger hover:bg-danger-soft disabled:opacity-60"
              data-testid="task-source-detach-submit"
              disabled={busy}
              type="button"
              onClick={() => void detach()}
            >
              {busy ? labels.detaching : labels.confirm}
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
