"use client";

import type { ReactElement } from "react";

import { useTranslations } from "next-intl";

import { ConfigPersistDialog } from "./config-persist-dialog";
import {
  useConfigPersistence,
  useConfigStatus,
} from "./use-config-persistence";

export function ConfigPersistControl({
  slug,
  exportRevision,
}: {
  slug: string;
  exportRevision: string;
}): ReactElement {
  const t = useTranslations("projects.configPersistence");
  const { status, refresh, error } = useConfigStatus(slug, exportRevision);
  const controller = useConfigPersistence(slug, refresh);

  return (
    <section
      aria-label={t("title")}
      className="mb-3 space-y-3 rounded-lg border border-line bg-paper p-3"
    >
      <h3 className="font-semibold">{t("title")}</h3>
      <div
        aria-live="polite"
        className="text-sm"
        data-testid="config-persist-status"
      >
        <p>{t(`exportStates.${status?.exportState ?? "unverified"}`)}</p>
        <p>
          {t(`repositoryStates.${status?.repositoryState ?? "unavailable"}`)}
        </p>
        {status?.observedAt ? (
          <p className="text-xs text-mute">
            {t("observedAt")}:{" "}
            <time dateTime={status.observedAt}>
              {new Date(status.observedAt).toLocaleString()}
            </time>
          </p>
        ) : null}
        {status?.reason ? <p>{t(`reasons.${status.reason}`)}</p> : null}
        {error ? <p>{t("statusUnavailable")}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-lg bg-amber px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          data-testid="config-persist-open"
          type="button"
          onClick={() => void controller.show()}
        >
          {t("open")}
        </button>
        <button
          className="rounded-lg border border-line px-3 py-2 text-sm"
          disabled={controller.busy}
          type="button"
          onClick={() => void refresh()}
        >
          {t("refreshStatus")}
        </button>
        {status?.operationId ? (
          <button
            className="rounded-lg border border-line px-3 py-2 text-sm"
            disabled={controller.busy}
            type="button"
            onClick={() => void controller.readReceipt(status.operationId!)}
          >
            {t("previousReceipt")}
          </button>
        ) : null}
      </div>
      <ConfigPersistDialog controller={controller} />
    </section>
  );
}
