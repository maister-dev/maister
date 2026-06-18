"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

// Repo-tab "fetch origin" control: refreshes remote-tracking refs via the
// existing remotes op, then re-renders so the branch list reflects origin.
// The fetch is read-only (no working-tree change); advisory warnings (offline,
// auth) surface inline rather than as a hard failure.
export function RepoFetchButton({
  slug,
  label,
  pendingLabel,
  failedLabel,
}: {
  slug: string;
  label: string;
  pendingLabel: string;
  failedLabel: string;
}): ReactElement {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onFetch(): Promise<void> {
    setBusy(true);
    setNote(null);

    try {
      const res = await fetch(`/api/projects/${slug}/remotes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "fetch", name: "origin" }),
      });
      const data = (await res.json().catch(() => null)) as {
        message?: string;
        warning?: string;
      } | null;

      if (!res.ok) {
        setNote(data?.message ?? failedLabel);

        return;
      }
      if (typeof data?.warning === "string") setNote(data.warning);
      startTransition(() => router.refresh());
    } catch {
      setNote(failedLabel);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {note ? (
        <span
          className="font-mono text-[11px] font-semibold text-amber"
          role="alert"
        >
          {note}
        </span>
      ) : null}
      <button
        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
        disabled={busy}
        type="button"
        onClick={() => void onFetch()}
      >
        {busy ? pendingLabel : label}
      </button>
    </div>
  );
}
