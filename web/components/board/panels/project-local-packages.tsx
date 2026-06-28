import type { ProjectLocalPackageView } from "@/lib/queries/project-local-packages";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

// Project-owned local packages (M39 centralized drafts that belong to this
// project). Rows only — their contents are edited in Studio, not rendered here.
export async function ProjectLocalPackages({
  localPackages,
}: {
  localPackages: ProjectLocalPackageView[];
}): Promise<ReactElement | null> {
  if (localPackages.length === 0) return null;

  const t = await getTranslations("packages");

  return (
    <section className="mb-6 rounded-[16px] border border-line bg-paper p-6">
      <h3 className="m-0 mb-4 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {t("localTitle")}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {localPackages.map((pkg) => (
          <li
            key={pkg.id}
            className="flex items-center justify-between gap-3 rounded-[10px] border border-line-soft bg-ivory px-4 py-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-ink">
                {pkg.name}
              </span>
              <span className="rounded-full border border-line bg-paper px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                {t("localBadge")}
              </span>
              <span className="font-mono text-[11px] text-mute">
                {pkg.origin.kind === "forked"
                  ? t("localOriginForked", {
                      package: pkg.origin.packageName,
                      version: pkg.origin.versionLabel,
                    })
                  : t("localOriginLocal")}
              </span>
            </div>
            <Link
              className="shrink-0 rounded-[8px] border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-paper"
              href={`/studio/edit/${pkg.id}`}
            >
              {t("localEdit")}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
