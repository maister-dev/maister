"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

// Forks an installed package into a fresh local package, then opens the editor —
// the agreed fork → edit-in-project → PR-upstream flow (installed packages stay
// immutable). `refName` is the package name (Phase A ref); fork resolution
// happens server-side, so no disk handle crosses the wire. Shared by the package
// card and the flow viewer so "edit" is reachable from both.
//
// Fork dedup (A3): packages are centralized, so a second fork of the same
// install returns the EXISTING fork (HTTP 200, `alreadyExists`). Rather than
// silently opening a fork the author may not expect, surface a choice: open the
// existing fork, or make a fresh copy (`forceNew`).
export function ForkToEditButton({
  refName,
  targetPath,
}: {
  refName: string;
  targetPath?: string;
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);

  async function fork(forceNew: boolean): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/studio/packages/${encodeURIComponent(refName)}/fork`,
        forceNew
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ forceNew: true }),
            }
          : { method: "POST" },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      const result = (await res.json()) as {
        localPackageId: string;
        alreadyExists?: boolean;
      };

      if (result.alreadyExists && !forceNew) {
        setExistingId(result.localPackageId);

        return;
      }

      const pathSuffix = targetPath ? `/${encodePath(targetPath)}` : "";

      router.push(`/studio/edit/${result.localPackageId}${pathSuffix}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        className="rounded-[10px] border border-line bg-ivory px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-60"
        data-testid="package-fork"
        disabled={busy}
        title={t("reworkHint")}
        type="button"
        onClick={() => void fork(false)}
      >
        {t("rework")}
      </button>
      {existingId ? (
        <span
          className="flex flex-col gap-1 rounded-[10px] border border-line bg-paper px-2.5 py-2 text-[11.5px] text-ink-2"
          data-testid="package-fork-exists"
          role="status"
        >
          {t("forkExists")}
          <span className="flex gap-3">
            <button
              className="font-semibold text-amber hover:underline"
              data-testid="package-fork-open-existing"
              type="button"
              onClick={() => router.push(`/studio/edit/${existingId}`)}
            >
              {t("forkOpenExisting")}
            </button>
            <button
              className="text-ink-2 hover:text-ink hover:underline disabled:opacity-60"
              data-testid="package-fork-new-copy"
              disabled={busy}
              type="button"
              onClick={() => void fork(true)}
            >
              {t("forkNewCopy")}
            </button>
          </span>
        </span>
      ) : null}
      {error ? (
        <span className="font-mono text-[10.5px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
