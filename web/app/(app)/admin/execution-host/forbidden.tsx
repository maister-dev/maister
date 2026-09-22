import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function ExecutionHostForbidden(): Promise<ReactElement> {
  const t = await getTranslations("adminExecutionHost.forbidden");

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col justify-center">
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-danger">
        403
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-ink">{t("title")}</h1>
      <p className="mt-3 text-sm leading-6 text-mute">{t("body")}</p>
      <Link className="mt-5 font-semibold text-ink underline" href="/">
        {t("back")}
      </Link>
    </main>
  );
}
