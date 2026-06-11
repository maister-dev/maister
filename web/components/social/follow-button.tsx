"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface FollowButtonLabels {
  follow: string;
  unfollow: string;
  busy: string;
}

export function FollowButton({
  slug,
  taskNumber,
  isFollowing,
  labels,
}: {
  slug: string;
  taskNumber: number;
  isFollowing: boolean;
  labels: FollowButtonLabels;
}): ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle(): Promise<void> {
    if (busy) return;
    setBusy(true);

    try {
      await fetch(`/api/projects/${slug}/tasks/${taskNumber}/subscription`, {
        method: isFollowing ? "DELETE" : "POST",
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className="rounded-lg border border-line bg-paper px-2.5 py-1 text-[12px] font-semibold text-ink transition hover:border-amber hover:text-amber disabled:opacity-50"
      disabled={busy}
      type="button"
      onClick={() => void toggle()}
    >
      {busy ? labels.busy : isFollowing ? labels.unfollow : labels.follow}
    </button>
  );
}
