"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

// (M39 A3) Forks ONE element of an installed package into a NEW centralized local
// package, then opens the editor. A small client island inside the otherwise
// presentational ElementCard; rendered only when the element has a resolvable
// source path (`elementPath`). `refName` is the package ref — the server resolves
// the install; `elementName` is the new package's display name.
export function ElementForkButton({
  refName,
  elementPath,
  elementName,
  label,
}: {
  refName: string;
  elementPath: string;
  elementName: string;
  label: string;
}): ReactElement {
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fork(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/studio/packages/${encodeURIComponent(refName)}/fork-element`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ elementPath, elementName }),
        },
      );

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      const result = (await res.json()) as { localPackageId: string };

      router.push(`/studio/edit/${result.localPackageId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        className="rounded-[9px] border border-line bg-ivory px-2.5 py-1 text-[12px] font-semibold text-ink transition-colors hover:border-amber disabled:opacity-60"
        data-testid="element-card-fork"
        disabled={busy}
        type="button"
        onClick={() => void fork()}
      >
        {label}
      </button>
      {error ? (
        <span className="font-mono text-[10px] text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
