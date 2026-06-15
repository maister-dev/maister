"use client";

import type { PackageGroup } from "@/lib/studio/group-packages";

import Link from "next/link";
import { useTranslations } from "next-intl";

type AreaCard = { href: string; title: string; sub: string };

export function OverviewCards({
  groups,
  isAdmin,
}: {
  groups: PackageGroup[];
  isAdmin: boolean;
}) {
  const t = useTranslations("studio");

  const localCount = groups.filter((group) => group.isLocal).length;
  const artifactCount = groups.reduce(
    (sum, group) =>
      sum +
      group.counts.flows +
      group.counts.skills +
      group.counts.agents +
      group.counts.mcps +
      group.counts.rules,
    0,
  );
  const needsAttention = groups.filter((group) => group.needsTrust);

  const stats = [
    { label: t("packagesTitle"), value: groups.length },
    { label: t("localTitle"), value: localCount },
    { label: t("artifacts"), value: artifactCount },
  ];

  const areas: AreaCard[] = [
    {
      href: "/studio/packages",
      title: t("packagesTitle"),
      sub: t("packagesSub"),
    },
    { href: "/studio/local", title: t("localTitle"), sub: t("localSub") },
  ];

  if (isAdmin) {
    areas.push({
      href: "/studio/sources",
      title: t("sourcesTitle"),
      sub: t("sourcesSub"),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-[14px] border border-line bg-paper px-5 py-4"
          >
            <div className="text-[26px] font-semibold leading-none text-ink">
              {stat.value}
            </div>
            <div className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-mute">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {areas.map((area) => (
          <Link
            key={area.href}
            className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-paper px-5 py-4 transition-colors hover:border-amber"
            href={area.href}
          >
            <span className="text-[15px] font-semibold text-ink">
              {area.title}
            </span>
            <span className="text-[12.5px] leading-[1.45] text-mute">
              {area.sub}
            </span>
          </Link>
        ))}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("needsAttention")}
        </h2>
        {needsAttention.length > 0 ? (
          <ul className="flex list-none flex-col gap-1.5">
            {needsAttention.map((group) => (
              <li key={group.key}>
                <Link
                  className="flex items-center justify-between gap-3 rounded-[12px] border border-amber-line bg-amber-soft px-4 py-2.5 text-[13px] text-ink transition-colors hover:border-amber"
                  href={`/studio/packages/${encodeURIComponent(group.name)}`}
                >
                  <span className="font-semibold">{group.name}</span>
                  <span className="font-mono text-[11px] text-amber">
                    {t("needsTrust")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-mute">{t("needsAttentionEmpty")}</p>
        )}
      </section>
    </div>
  );
}
