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

  async function fork(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/studio/packages/${encodeURIComponent(refName)}/fork`,
        { method: "POST" },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      const result = (await res.json()) as { localPackageId: string };
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
        onClick={() => void fork()}
      >
        {t("rework")}
      </button>
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
