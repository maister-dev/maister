import type { ReactElement, ReactNode, RefObject } from "react";

export interface ConfirmDialogFrameProps {
  body: string;
  busy: boolean;
  cancelLabel: string;
  children: ReactNode;
  dialogRef?: RefObject<HTMLDivElement | null>;
  testId: string;
  title: string;
  titleId: string;
  onClose: () => void;
}

export function ConfirmDialogFrame({
  body,
  busy,
  cancelLabel,
  children,
  dialogRef,
  testId,
  title,
  titleId,
  onClose,
}: ConfirmDialogFrameProps): ReactElement {
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <button
        aria-label={cancelLabel}
        className="absolute inset-0 cursor-default bg-[rgba(22,20,15,0.45)] backdrop-blur-sm"
        disabled={busy}
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-[460px] flex-col overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-lg)]"
        data-testid={testId}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <h2
            className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink"
            id={titleId}
          >
            {title}
          </h2>
          <button
            aria-label={cancelLabel}
            className="font-mono text-[14px] text-mute hover:text-ink disabled:opacity-50"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-5">
          <p className="m-0 text-[13px] leading-[1.5] text-body">{body}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
