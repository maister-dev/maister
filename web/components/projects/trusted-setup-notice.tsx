"use client";

import type { ReactElement } from "react";

import Link from "next/link";
import { useTranslations } from "next-intl";

export function TrustedSetupNotice({ href }: { href: string }): ReactElement {
  const t = useTranslations("dependencies");

  return (
    <>
      {t("trustAccepted")}{" "}
      <Link className="underline" href={href}>
        {t("inspectTrustedSetup")}
      </Link>
    </>
  );
}
