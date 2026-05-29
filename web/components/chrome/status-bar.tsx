import type { PlatformStatus } from "@/types/platform-status";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { PlatformStatusPill } from "@/components/chrome/platform-status";

export interface StatusBarProps {
  platformStatus: PlatformStatus;
  summary?: string;
}

export async function StatusBar({
  platformStatus,
  summary,
}: StatusBarProps): Promise<ReactElement> {
  const t = await getTranslations("status");

  return (
    <footer
      aria-label="Instance status"
      className="fixed inset-x-0 bottom-0 z-30 flex h-9 items-center justify-between border-t border-line bg-paper px-6 font-mono text-[10.5px] tracking-[0.04em] text-mute backdrop-blur-[8px]"
    >
      <div className="flex items-center gap-3.5">
        <PlatformStatusPill
          labels={{
            ready: t("supervisorReady"),
            unavailable: t("supervisorUnavailable"),
          }}
          status={platformStatus}
        />
        <span className="text-line">·</span>
        <span>localhost:3000</span>
        <span className="hidden text-line sm:inline">·</span>
        <span className="hidden sm:inline">
          {platformStatus.kind === "ready"
            ? `supervisor v${platformStatus.health.version}`
            : t("supervisor")}
        </span>
        {summary ? (
          <>
            <span className="hidden text-line sm:inline">·</span>
            <span className="hidden sm:inline">{summary}</span>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-3.5">
        <Link
          className="inline-flex items-center gap-1.5 text-mute transition-colors hover:text-ink"
          href="https://github.com/kanischev/mAIster/tree/main/docs"
          rel="noreferrer"
          target="_blank"
        >
          {t("docs")} ↗
        </Link>
        <span className="text-line">·</span>
        <a
          className="inline-flex items-center gap-1.5 text-mute transition-colors hover:text-ink"
          href="https://github.com/kanischev/mAIster"
          rel="noreferrer"
          target="_blank"
        >
          <svg
            aria-hidden="true"
            className="h-[11px] w-[11px]"
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.08.55-.17.55-.38v-1.5c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.22.83 1.22.83.72 1.23 1.88.87 2.34.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
        </a>
      </div>
    </footer>
  );
}
