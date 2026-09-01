"use client";

import type { ReactElement, ReactNode } from "react";

import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useState } from "react";

export interface CheckoutContextProps {
  branch: string;
  // The REAL worktree path. This is what the copy button puts on the clipboard,
  // so what the operator pastes into a shell actually resolves.
  worktreePath: string;
  // Optional abbreviated form rendered in the field. Display and clipboard are
  // deliberately separate values: rendering the real absolute path leaks the
  // host layout, while copying the abbreviated one hands over a string that
  // cannot be `cd`-ed into. Defaults to the real path when absent.
  displayWorktreePath?: string;
  // Extra run-specific context rendered inside the box (e.g. the re-entry node).
  children?: ReactNode;
}

// The local checkout affordance shared by the ADR-030 manual takeover and the
// ADR-160 rework claim. Both hand the same worktree to a human editing it on
// the host, so the block has exactly one implementation.
export function CheckoutContext({
  branch,
  worktreePath,
  displayWorktreePath,
  children,
}: CheckoutContextProps): ReactElement {
  const t = useTranslations("checkoutContext");
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(worktreePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — the value stays selectable in the field.
    }
  }

  return (
    <>
      <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {t("title")}
      </div>
      <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-ivory p-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            {t("branch")}
          </span>
          <input
            readOnly
            className="rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
            value={branch}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
            worktree
          </span>
          <div className="flex items-center gap-2">
            <input
              readOnly
              className="min-w-0 flex-1 rounded-[6px] border border-line-soft bg-paper px-2 py-1 font-mono text-[11px] text-ink-2"
              value={displayWorktreePath ?? worktreePath}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              aria-label={t("copy")}
              className="flex-none rounded-[6px] border border-line bg-paper px-2 py-1 text-mute hover:text-ink-2"
              type="button"
              onClick={() => void copy()}
            >
              {copied ? (
                <CheckIcon aria-hidden className="size-4 text-[#2f9e44]" />
              ) : (
                <ClipboardDocumentIcon aria-hidden className="size-4" />
              )}
            </button>
          </div>
        </label>
        {children}
      </div>
    </>
  );
}
