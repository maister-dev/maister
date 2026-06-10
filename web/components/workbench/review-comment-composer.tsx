"use client";

import type { ReactElement } from "react";

import { useState } from "react";

export interface ReviewCommentComposerLabels {
  placeholder: string;
  submit: string;
  cancel: string;
}

export interface ReviewCommentComposerProps {
  labels: ReviewCommentComposerLabels;
  busy?: boolean;
  initialValue?: string;
  onSubmit: (body: string) => void | Promise<void>;
  onCancel?: () => void;
}

// Presentational draft box for root comments, replies, and in-place edits
// (ADR-071). Owns only the draft text; persistence and error surfacing live
// in the owner's onSubmit — a rejected submit keeps the draft for retry.
export function ReviewCommentComposer({
  labels,
  busy = false,
  initialValue = "",
  onSubmit,
  onCancel,
}: ReviewCommentComposerProps): ReactElement {
  const [value, setValue] = useState(initialValue);

  const handleSubmit = async (): Promise<void> => {
    const body = value.trim();

    if (!body) return;

    try {
      await onSubmit(body);
    } catch {
      return;
    }
    setValue("");
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="review-composer">
      <textarea
        aria-label={labels.placeholder}
        className="min-h-[64px] w-full resize-y rounded-[8px] border border-line bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-mute disabled:opacity-50"
        data-testid="review-composer-input"
        disabled={busy}
        placeholder={labels.placeholder}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex justify-end gap-1.5">
        {onCancel ? (
          <button
            className="rounded-[6px] px-2 py-1 font-mono text-[11px] text-ink-2 hover:bg-ivory disabled:opacity-50"
            data-testid="review-composer-cancel"
            disabled={busy}
            type="button"
            onClick={onCancel}
          >
            {labels.cancel}
          </button>
        ) : null}
        <button
          className="rounded-[6px] bg-ivory px-2 py-1 font-mono text-[11px] font-semibold text-ink-2 hover:bg-line disabled:opacity-50"
          data-testid="review-composer-submit"
          disabled={busy || value.trim() === ""}
          type="button"
          onClick={() => void handleSubmit()}
        >
          {labels.submit}
        </button>
      </div>
    </div>
  );
}
