"use client";

import type { ReactElement } from "react";
import type { ConfirmDialogFrameProps } from "@/components/feedback/confirm-dialog-frame";

import { useRef } from "react";
import { createPortal } from "react-dom";

import { ConfirmDialogFrame } from "@/components/feedback/confirm-dialog-frame";
import { useModalFocusTrap } from "@/components/feedback/use-modal-focus-trap";

export interface ConfirmDialogProps
  extends Omit<ConfirmDialogFrameProps, "dialogRef" | "onClose"> {
  onClose: () => void;
}

export function ConfirmDialog({
  busy,
  onClose,
  ...props
}: ConfirmDialogProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);

  function requestClose(): void {
    if (!busy) onClose();
  }

  useModalFocusTrap(dialogRef, requestClose);

  if (typeof document === "undefined") return null;

  return createPortal(
    <ConfirmDialogFrame
      {...props}
      busy={busy}
      dialogRef={dialogRef}
      onClose={requestClose}
    />,
    document.body,
  );
}
