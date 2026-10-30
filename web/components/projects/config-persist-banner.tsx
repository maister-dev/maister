"use client";

import type { ReactElement } from "react";
import type { ConfigPersistenceController } from "./use-config-persistence";

import { Button } from "@heroui/react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { ConfigPersistContent } from "./config-persist-control";
import { ConfigPersistDialog } from "./config-persist-dialog";
import {
  useConfigPersistence,
  useConfigStatus,
} from "./use-config-persistence";

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
  const { status, refresh, error } = useConfigStatus(
    props.slug,
    props.exportRevision,
  );
  const controller = useConfigPersistence(props.slug, refresh);
  const [reviewOpened, setReviewOpened] = useState(false);
  const bannerController: ConfigPersistenceController = {
    ...controller,
    show(): Promise<void> {
      setReviewOpened(true);

      return controller.show();
    },
    readReceipt(operationId: string): Promise<void> {
      setReviewOpened(true);

      return controller.readReceipt(operationId);
    },
  };

  const showBanner =
    props.canEdit &&
    !dismissed &&
    (reviewOpened || (status !== null && status.exportState !== "in_sync"));

  return (
    <>
      {showBanner ? (
        <aside className="mb-5 rounded-xl border border-amber-line bg-amber-soft p-4">
          <p className="font-semibold">{props.projectName}</p>
          <ConfigPersistContent
            controller={bannerController}
            error={error}
            refresh={refresh}
            status={status}
          />
          <a className="text-sm underline" href={props.settingsHref}>
            {t("persistBanner.settingsLink")}
          </a>
          <Button
            className="ml-3 rounded border border-line px-2 py-1 text-sm"
            type="button"
            onPress={() => {
              window.localStorage.setItem(key, "1");
              setDismissed(true);
            }}
          >
            {t("persistBanner.dismiss")}
          </Button>
        </aside>
      ) : null}
      <ConfigPersistDialog controller={controller} />
    </>
  );
}
