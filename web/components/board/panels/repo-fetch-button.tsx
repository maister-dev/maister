"use client";

import type { ReactElement } from "react";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { useFeedback } from "@/components/feedback/feedback-provider";
import { apiErrorText } from "@/lib/api-error";

export function RepoFetchButton({
  slug,
  branch,
  label,
  pendingLabel,
  failedLabel,
}: {
  slug: string;
  branch: string;
  label: string;
  pendingLabel: string;
  failedLabel: string;
}): ReactElement {
  const router = useRouter();
  const t = useTranslations("workbench.files");
  const tErr = useTranslations("apiErrors");
  const feedback = useFeedback();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onFetch(): Promise<void> {
    const mutationId = `repo-pull:${slug}:${branch}:${Date.now()}`;
    const fail = (message: string): void => {
      setNote(message);
      feedback.error({ message, mutationId });
    };

    setBusy(true);
    setNote(null);

    try {
      const res = await fetch(`/api/projects/${slug}/remotes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "pull", name: "origin", branch }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        code?: string;
        warning?: string;
        details?: { reason?: string };
      } | null;

      if (!res.ok) {
        if (
          data?.code === "PRECONDITION" &&
          data.details?.reason === "branch_mismatch"
        ) {
          fail(t("pullBranchMismatch", { branch }));
        } else if (
          data?.code === "PRECONDITION" &&
          data.details?.reason === "dirty_worktree"
        ) {
          fail(t("pullDirty"));
        } else if (data?.code === "CONFLICT") {
          fail(t("pullConflict"));
        } else if (data?.code === "EXECUTOR_UNAVAILABLE") {
          fail(t("pullUnavailable"));
        } else {
          fail(apiErrorText(data, tErr));
        }

        return;
      }
      if (data?.ok !== true || data.warning !== undefined) {
        fail(failedLabel);

        return;
      }
      startTransition(() => router.refresh());
      feedback.success({ message: t("pullComplete"), mutationId });
    } catch {
      fail(failedLabel);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {note ? (
        <span
          className="max-w-lg font-mono text-[11px] font-semibold text-rust"
          role="alert"
        >
          {note}
        </span>
      ) : null}
      <Button
        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
        isDisabled={busy || isPending}
        size="sm"
        type="button"
        variant="outline"
        onPress={() => void onFetch()}
      >
        <ArrowPathIcon aria-hidden="true" className="size-4" />
        {busy || isPending ? pendingLabel : label}
      </Button>
    </div>
  );
}
