import "server-only";

import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

/** A source may disappear or become private while the execution itself remains in history. */
export async function RunSourceUnavailable(): Promise<ReactElement> {
  const t = await getTranslations("run");

  return (
    <section
      className="rounded-lg border border-line bg-paper p-6"
      role="alert"
    >
      <h2 className="font-semibold">{t("sourceUnavailableTitle")}</h2>
      <p className="mt-2 text-sm text-mute">
        {t("sourceUnavailableDescription")}
      </p>
    </section>
  );
}
