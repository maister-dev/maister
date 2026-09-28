"use client";

import type { ReactElement } from "react";

import { BookOpenIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useTranslations } from "next-intl";

import { useLibrarian } from "@/components/librarian/librarian-provider";

const navTool = clsx(
  "relative inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line",
  "px-2.5 py-[7px] font-mono text-[11px] leading-none tracking-[0.04em]",
  "text-mute transition-colors hover:border-mute hover:text-ink",
);

// ADR-191 D1/D2: the entry names the indicator STATE in its accessible name
// and shows it as a dot — never a number. Only `action_required` wears the
// attention tone; it is the one state the reader can act on.
export function LibrarianTrigger(): ReactElement | null {
  const t = useTranslations("librarian");
  const librarian = useLibrarian();

  if (!librarian) return null;
  const { indicator, open } = librarian;
  const label =
    indicator === "none"
      ? t("entryLabel")
      : `${t("entryLabel")} — ${t(`indicator_${indicator}`)}`;

  return (
    <button
      aria-controls="librarian-panel"
      aria-expanded={open}
      aria-label={label}
      className={clsx(navTool, open && "border-mute text-ink")}
      data-indicator={indicator}
      data-testid="librarian-trigger"
      title={label}
      type="button"
      onClick={(event) =>
        open ? librarian.closePanel() : librarian.openPanel(event.currentTarget)
      }
    >
      <BookOpenIcon aria-hidden className="h-4 w-4" />
      <span className="hidden md:inline">{t("entryLabel")}</span>
      {indicator === "none" ? null : (
        <span
          aria-hidden
          className={clsx(
            "absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-paper-warm",
            indicator === "action_required" ? "bg-amber" : "bg-mute",
          )}
          data-testid="librarian-indicator-dot"
        />
      )}
    </button>
  );
}
