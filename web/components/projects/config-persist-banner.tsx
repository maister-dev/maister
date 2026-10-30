"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { ConfigPersistControl } from "./config-persist-control";
import { useConfigStatus } from "./use-config-persistence";

export interface ConfigPersistBannerProps {
  slug: string;
  projectName: string;
  exportRevision: string;
  canEdit: boolean;
  settingsHref: string;
}

export function ConfigPersistBanner(
  props: ConfigPersistBannerProps,
): ReactElement | null {
  const t = useTranslations("projects");
  const key = `maister.persistBanner.dismissed.${props.slug}`;
  const [dismissed, setDismissed] = useState(
    () =>
      typeof window !== "undefined" && window.localStorage.getItem(key) === "1",
  );
  const { status } = useConfigStatus(props.slug, props.exportRevision);

  if (
    !props.canEdit ||
    dismissed ||
    !status ||
    status.exportState === "in_sync"
  )
    return null;

  return (
    <aside className="mb-5 rounded-xl border border-amber-line bg-amber-soft p-4">
      <p className="font-semibold">{props.projectName}</p>
      <ConfigPersistControl
        exportRevision={props.exportRevision}
        slug={props.slug}
      />
      <a className="text-sm underline" href={props.settingsHref}>
        {t("persistBanner.settingsLink")}
      </a>
      <button
        className="ml-3 rounded border border-line px-2 py-1 text-sm"
        type="button"
        onClick={() => {
          window.localStorage.setItem(key, "1");
          setDismissed(true);
        }}
      >
        {t("persistBanner.dismiss")}
      </button>
    </aside>
  );
}
