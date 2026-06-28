"use client";

import type { ReactElement } from "react";

import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

export type AttachTarget = {
  slug: string;
  name: string;
  attached: boolean;
};

// Studio "attach to a project" dialog: lists the projects the viewer manages,
// linking the ones this package is already attached to and offering a one-click
// attach (POST /api/projects/[slug]/packages) for the rest. Attaching the newest
// install matches the project Packages-tab attach; the version can be changed
// there afterwards.
export function AttachToProjectButton({
  targets,
  installId,
  triggerClassName,
  defaultOpen = false,
}: {
  targets: AttachTarget[];
  installId: string;
  triggerClassName: string;
  defaultOpen?: boolean;
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const openRef = useRef(open);

  openRef.current = open;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && openRef.current) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  async function attach(slug: string): Promise<void> {
    setBusy(slug);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${slug}/packages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageInstallId: installId }),
      });

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      // Re-fetch the page so `targets` reflects the new attachment (the row
      // flips to the already-attached link).
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        className={triggerClassName}
        data-testid="attach-to-project"
        type="button"
        onClick={() => setOpen(true)}
      >
        {t("attach")}
      </button>

      {open ? (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="attach-dialog"
          role="dialog"
        >
          <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-[16px] border border-line bg-paper p-6 shadow-xl">
            <h3 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
              {t("attachTitle")}
            </h3>

            {targets.length === 0 ? (
              <p
                className="rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[11px] text-mute"
                data-testid="attach-empty"
              >
                {t("attachEmpty")}
              </p>
            ) : (
              <ul className="m-0 flex max-h-[55vh] list-none flex-col gap-2 overflow-auto p-0">
                {targets.map((target) => (
                  <li
                    key={target.slug}
                    className="flex items-center justify-between gap-3 rounded-[10px] border border-line-soft bg-ivory px-3 py-2"
                  >
                    <span className="truncate text-[13px] font-medium text-ink">
                      {target.name}
                    </span>
                    {target.attached ? (
                      <Link
                        className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-emerald-600 hover:underline"
                        href={`/projects/${target.slug}?tab=packages`}
                      >
                        <CheckIcon className="h-4 w-4" />
                        {t("attachAttached")}
                        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                      </Link>
                    ) : (
                      <button
                        className="shrink-0 rounded-[8px] border border-amber bg-amber px-3 py-1 text-[12px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
                        data-testid={`attach-do-${target.slug}`}
                        disabled={busy === target.slug}
                        type="button"
                        onClick={() => void attach(target.slug)}
                      >
                        {t("attachAction")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {error ? (
              <p
                className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger"
                data-testid="attach-error"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            <div className="flex items-center justify-end">
              <button
                className="rounded-[10px] border border-line bg-paper px-3 py-2 text-[12px] text-mute hover:text-ink-2"
                data-testid="attach-close"
                type="button"
                onClick={() => setOpen(false)}
              >
                {t("attachClose")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
