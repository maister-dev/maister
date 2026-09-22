import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { forbidden } from "next/navigation";

import { ExecutionHostStatus } from "@/components/admin/execution-host-status";
import { isMaisterError } from "@/lib/errors";
import {
  parsePoisonCursorSearchParams,
  requireAdminExecutionHostStatus,
} from "@/lib/execution-host/admin-status";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adminExecutionHost");

  return { title: t("title") };
}

export default async function AdminExecutionHostPage({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<ReactElement> {
  const t = await getTranslations("adminExecutionHost");
  const cursor = parsePoisonCursorSearchParams(await searchParams);
  let status;

  try {
    status = await requireAdminExecutionHostStatus({
      ...(cursor ? { poisonAfter: cursor } : {}),
    });
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED") forbidden();
    throw error;
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")}
        </div>
        <div>
          <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-[760px] text-[13.5px] leading-[1.55] text-mute">
            {t("subtitle")}
          </p>
        </div>
      </header>

      <ExecutionHostStatus status={status} />
    </div>
  );
}
