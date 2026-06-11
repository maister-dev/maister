"use client";

import type { ReactElement } from "react";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ForkButtonLabels {
  fork: string;
  pending: string;
  errorConflict: string;
  errorConfig: string;
  errorUnauthorized: string;
  errorGeneric: string;
}

export interface PackageForkButtonProps {
  projectSlug: string;
  flowRefId: string;
  revisionId: string;
  labels: ForkButtonLabels;
}

// Branch on the typed `MaisterError` code from `catalogErrorResponse`
// (`{ code, message }`), NEVER the message string. Unknown/CRASH → generic.
export function forkErrorMessage(
  code: string,
  labels: ForkButtonLabels,
): string {
  switch (code) {
    case "CONFLICT":
      return labels.errorConflict;
    case "CONFIG":
      return labels.errorConfig;
    case "UNAUTHORIZED":
      return labels.errorUnauthorized;
    default:
      return labels.errorGeneric;
  }
}

const BTN_PRIMARY =
  "w-full rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-50";

export function PackageForkButton({
  projectSlug,
  flowRefId,
  revisionId,
  labels,
}: PackageForkButtonProps): ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fork(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/flow-packages/${encodeURIComponent(flowRefId)}/revisions/${encodeURIComponent(revisionId)}/fork`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;

        setError(forkErrorMessage(data?.code ?? "CRASH", labels));
        setBusy(false);

        return;
      }

      const result = (await res.json()) as {
        capId: string;
        projectSlug: string;
      };

      router.push(`/flows/${result.projectSlug}/${result.capId}`);
    } catch {
      setError(labels.errorGeneric);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        className={BTN_PRIMARY}
        data-testid="package-fork-button"
        disabled={busy}
        type="button"
        onClick={() => void fork()}
      >
        {busy ? labels.pending : labels.fork}
      </button>
      {error ? (
        <p
          aria-live="assertive"
          className="m-0 rounded-lg border border-amber-line bg-amber-soft px-2.5 py-1.5 font-mono text-[10px] font-semibold text-amber"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
