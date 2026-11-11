import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { requireSession } from "@/lib/authz";
import { resolveStudioPackageByRef } from "@/lib/studio/load";
import {
  studioPackagePath,
  withPackageInstall,
} from "@/lib/studio/package-links";

export async function loadStudioPackagePage(
  name: string,
  segments: string[],
  query: Record<string, string | string[] | undefined>,
) {
  const user = await requireSession();
  const resolution = await resolveStudioPackageByRef(
    user.id,
    user.role,
    name,
    query.install,
  );
  const path = studioPackagePath(name, ...segments);

  if (resolution.status === "not-found") notFound();

  if (resolution.status === "ok") {
    if (query.install === undefined)
      redirect(withPackageInstall(path, resolution.installId, query));

    return { kind: "selected" as const, user, resolution };
  }

  const t = await getTranslations("studio");
  const chooser: ReactElement = (
    <div data-testid="studio-package-chooser">
      <h1 className="mb-2 text-2xl font-semibold text-ink">{name}</h1>
      <p className="font-semibold text-ink">{t("ambiguousTitle")}</p>
      <p className="mb-3 text-mute">{t("ambiguousHint")}</p>
      <ul className="flex list-none flex-col gap-2">
        {resolution.matches.flatMap((group) =>
          group.versions.map((version) => (
            <li key={version.installId}>
              <Link
                className="block rounded-lg border border-line bg-paper px-4 py-3 text-ink hover:border-amber"
                href={withPackageInstall(path, version.installId, query)}
              >
                {group.sourceUrl} · {version.versionLabel}
              </Link>
            </li>
          )),
        )}
      </ul>
    </div>
  );

  return { kind: "choice" as const, chooser };
}
