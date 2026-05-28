"use client";

import type { Locale } from "@/lib/i18n";
import type { ReactElement } from "react";

import { useTransition } from "react";
import { useLocale } from "next-intl";
import clsx from "clsx";

import { setLocale } from "@/app/actions/locale";

const navTool = clsx(
  "inline-flex items-center gap-1.5 rounded-lg border border-line",
  "px-2.5 py-[7px] font-mono text-[11px] leading-none tracking-[0.04em]",
  "text-mute transition-colors cursor-pointer",
  "hover:border-mute hover:text-ink disabled:cursor-wait disabled:opacity-70",
);

export interface LangSwitchProps {
  className?: string;
}

export function LangSwitch({ className }: LangSwitchProps): ReactElement {
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();

  const current = (locale === "ru" ? "ru" : "en") as Locale;
  const other: Locale = current === "en" ? "ru" : "en";

  const handleToggle = () => {
    startTransition(() => {
      void setLocale(other);
    });
  };

  return (
    <button
      aria-label={`Switch language to ${other.toUpperCase()}`}
      className={clsx(navTool, className)}
      disabled={isPending}
      type="button"
      onClick={handleToggle}
    >
      <b className="font-semibold text-ink">{current.toUpperCase()}</b>
      <span className="text-mute">· {other.toUpperCase()}</span>
    </button>
  );
}
