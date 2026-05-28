import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

export async function EmptyState(): Promise<ReactElement> {
  const t = await getTranslations("portfolio");

  const tips = [t("esTip1"), t("esTip2"), t("esTip3")];

  return (
    <section className="flex flex-col items-center justify-center rounded-2xl border-[1.5px] border-dashed border-line bg-[repeating-linear-gradient(45deg,transparent_0_14px,color-mix(in_oklab,var(--line)_28%,transparent)_14px_15px)] px-6 pb-12 pt-20 text-center">
      <div className="mb-6 inline-flex h-[72px] w-[72px] items-center justify-center rounded-[20px] border border-amber-line bg-paper text-amber shadow-[0_20px_40px_-20px_var(--amber)]">
        <svg
          aria-hidden="true"
          className="h-8 w-8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 28 24"
        >
          <path d="M22 12 a8 8 0 1 1 -2.34 -5.66" />
          <polyline points="22 5 22 9 18 9" />
          <line x1="14" x2="14" y1="2" y2="4.5" />
          <circle cx="14" cy="1.6" fill="currentColor" r="1" stroke="none" />
          <circle cx="11" cy="12" fill="currentColor" r="1.2" stroke="none" />
          <circle cx="16" cy="12" fill="currentColor" r="1.2" stroke="none" />
        </svg>
      </div>
      <h2 className="mb-2 text-[26px] font-semibold tracking-[-0.022em] text-ink">
        {t("emptyTitle")}{" "}
        <em className="not-italic text-amber">{t("emptyTitleEm")}</em>
      </h2>
      <p className="mb-7 max-w-[44ch] text-sm leading-[1.55] text-mute">
        {t("emptyBody")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Link
          className="inline-flex items-center gap-2.5 rounded-full bg-amber px-[22px] py-3 text-[13.5px] font-semibold text-white shadow-[0_8px_24px_-8px_var(--amber)] transition-transform hover:-translate-y-px hover:bg-amber-2"
          href="/projects/new"
        >
          + {t("connectRepo")}{" "}
          <span className="font-mono opacity-[0.85]">→</span>
        </Link>
        <button
          className="rounded-full border border-line bg-paper px-[18px] py-3 text-[13.5px] font-medium text-ink-2 transition-colors hover:border-mute hover:text-ink"
          type="button"
        >
          {t("scaffold")}
        </button>
        <button
          className="rounded-full border border-line bg-paper px-[18px] py-3 text-[13.5px] font-medium text-ink-2 transition-colors hover:border-mute hover:text-ink"
          type="button"
        >
          {t("importLocal")}
        </button>
      </div>
      <div className="mt-8 grid w-full max-w-[640px] grid-cols-1 gap-3 sm:grid-cols-3">
        {tips.map((tip) => (
          <div
            key={tip}
            className="rounded-[10px] border border-line bg-paper px-3.5 py-3 text-left text-xs leading-[1.45] text-ink-2"
          >
            {tip}
          </div>
        ))}
      </div>
    </section>
  );
}
