"use client";

import type { ReactNode } from "react";

import { useState } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/24/outline";

export interface FilePaneShellLabels {
  copy: string;
  copied: string;
}

export interface FilePaneShellProps {
  path: string;
  content: string;
  labels: FilePaneShellLabels;
  children?: ReactNode;
}

// A client header over the server-rendered file viewer (M35 T4.2): the file
// path + a copy-to-clipboard control (HeroIcons). The viewer body (CodeView or
// MarkdownRichView) is passed as already-rendered server children. Only wraps
// non-empty text files — there must be content to copy.
export function FilePaneShell({
  path,
  content,
  labels,
  children,
}: FilePaneShellProps): ReactNode {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      // Best-effort reset; a missed timer just leaves the confirmed state.
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / permission denied) — no-op.
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="file-pane-shell">
      <div className="mb-2 flex flex-none items-center justify-between gap-2 rounded-[8px] border border-line bg-paper px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-mute">
          {path}
        </span>
        <button
          aria-label={labels.copy}
          className="inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-line bg-ivory px-2 py-1 font-mono text-[10px] font-semibold text-ink-2 hover:bg-paper"
          data-testid="file-copy-button"
          type="button"
          onClick={() => void copy()}
        >
          {copied ? (
            <CheckIcon className="h-3.5 w-3.5" />
          ) : (
            <ClipboardDocumentIcon className="h-3.5 w-3.5" />
          )}
          {copied ? labels.copied : labels.copy}
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
