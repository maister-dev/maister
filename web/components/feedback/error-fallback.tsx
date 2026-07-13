"use client";

import type { ReactElement } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { errorCodeFromUnknown } from "@/lib/error-presentation";

export interface ErrorFallbackProps {
  error: unknown;
  reset: () => void;
}

export function ErrorFallback({
  error,
  reset,
}: ErrorFallbackProps): ReactElement {
  const t = useTranslations("errorBoundary");
  const code = errorCodeFromUnknown(error);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-[640px] items-center px-5 py-12">
      <section className="w-full rounded-[16px] border border-line bg-paper p-6 shadow-[var(--shadow-sm)]">
        <p className="m-0 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-amber">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 font-sans text-2xl font-bold tracking-[-0.03em] text-ink">
          {t("title")}
        </h1>
        <p className="mt-2 text-[14px] leading-6 text-body">
          {t(code ? "known" : "generic")}
        </p>
        {code ? (
          <p
            className="mt-4 rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[11px] text-mute"
            data-testid="error-boundary-diagnostic"
          >
            {t("diagnosticCode", { code })}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="rounded-lg border border-amber bg-amber px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
            type="button"
            onClick={reset}
          >
            {t("reset")}
          </button>
          <Link
            className="rounded-lg border border-line bg-paper px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink"
            href="/"
          >
            {t("portfolio")}
          </Link>
        </div>
      </section>
    </main>
  );
}
