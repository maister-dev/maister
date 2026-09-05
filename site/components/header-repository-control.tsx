"use client";

import type { ReactElement } from "react";

import type { Locale } from "@/lib/locale";

import { useRepositorySummary } from "@/components/use-repository-summary";
import { GITHUB_URL } from "@/lib/site-config";

type HeaderRepositoryControlProps = {
  locale: Locale;
  starsLabel: string;
};

function formatStars(stars: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, {
    compactDisplay: "short",
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(stars);
}

export function HeaderRepositoryControl({
  locale,
  starsLabel,
}: HeaderRepositoryControlProps): ReactElement {
  const { state } = useRepositorySummary();
  const starCount =
    state.status === "ready" ? formatStars(state.data.stars, locale) : null;

  return (
    <a
      aria-label={starCount ? `GitHub, ${starCount} ${starsLabel}` : "GitHub"}
      className="header-repository"
      href={GITHUB_URL}
      rel="noreferrer"
      target="_blank"
    >
      <span className="header-repository-main">
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path
            d="M8 0a8 8 0 0 0-2.53 15.59c.4.08.55-.17.55-.38v-1.5c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.22.83 1.22.83.72 1.23 1.88.87 2.34.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"
            fill="currentColor"
          />
        </svg>
        <span className="header-repository-name">GitHub</span>
      </span>
      {starCount ? (
        <span className="header-repository-stars">
          <span aria-hidden="true">★</span>
          {starCount}
        </span>
      ) : null}
    </a>
  );
}
