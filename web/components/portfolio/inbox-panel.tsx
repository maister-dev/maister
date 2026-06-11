"use client";

import type { ReactElement } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { InboxItemView } from "@/lib/queries/inbox";

export interface InboxPanelLabels {
  title: string;
  ariaLabel: string;
  readAll: string;
  readAllBusy: string;
  empty: string;
  eventKind: Record<string, string>;
}

export function InboxPanel({
  items,
  count,
  labels,
}: {
  items: InboxItemView[];
  count: number;
  labels: InboxPanelLabels;
}): ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function markRead(itemId: string): Promise<void> {
    await fetch(`/api/inbox/${itemId}/read`, { method: "PATCH" }).catch(
      () => null,
    );
    router.refresh();
  }

  async function readAll(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/inbox/read-all", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={labels.ariaLabel}
      className="rounded-[12px] border border-line bg-paper p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-mute">
          {labels.title}
          <span className="ml-2 rounded-full border border-amber-line bg-amber-soft px-2 py-px text-amber">
            {count}
          </span>
        </h2>
        {count > 0 ? (
          <button
            className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-mute transition hover:border-amber hover:text-amber disabled:opacity-50"
            disabled={busy}
            type="button"
            onClick={() => void readAll()}
          >
            {busy ? labels.readAllBusy : labels.readAll}
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-[12px] text-mute">{labels.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-ivory/40 px-2.5 py-1.5 font-mono text-[11px]"
            >
              <span
                aria-hidden
                className={
                  item.read
                    ? "h-1.5 w-1.5 flex-none rounded-full bg-mute-2 opacity-40"
                    : "h-1.5 w-1.5 flex-none rounded-full bg-amber"
                }
              />
              <span className="flex-none text-mute">{item.projectName}</span>
              <Link
                className="flex-none rounded border border-line bg-paper px-1 py-px text-[10px] font-bold tracking-[0.05em] text-ink-2 hover:border-amber hover:text-amber"
                href={`/projects/${item.projectSlug}/tasks/${item.taskNumber}`}
                onClick={() => void markRead(item.id)}
              >
                {item.keyRef}
              </Link>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {item.taskTitle}
              </span>
              <span className="flex-none text-[10px] uppercase tracking-[0.06em] text-mute">
                {labels.eventKind[item.eventKind] ?? item.eventKind}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
