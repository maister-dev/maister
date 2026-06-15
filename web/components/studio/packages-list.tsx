"use client";

import type { PackageGroup } from "@/lib/studio/group-packages";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

type TrustFilter = "all" | "trusted" | "untrusted";

const KIND_LABEL_KEYS: { key: keyof PackageGroup["counts"]; label: string }[] =
  [
    { key: "flows", label: "kindFlows" },
    { key: "skills", label: "kindSkills" },
    { key: "agents", label: "kindAgents" },
    { key: "mcps", label: "kindMcps" },
    { key: "rules", label: "kindRules" },
  ];

export function PackagesList({ groups }: { groups: PackageGroup[] }) {
  const t = useTranslations("studio");
  const [query, setQuery] = useState("");
  const [trust, setTrust] = useState<TrustFilter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return groups.filter((group) => {
      const matchesQuery =
        q === "" ||
        group.name.toLowerCase().includes(q) ||
        group.sourceUrl.toLowerCase().includes(q);
      const matchesTrust =
        trust === "all" ||
        (trust === "untrusted" ? group.needsTrust : !group.needsTrust);

      return matchesQuery && matchesTrust;
    });
  }, [groups, query, trust]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("filterName")}
          className="min-w-[220px] flex-1 rounded-[10px] border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-mute"
          placeholder={t("filterName")}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label={t("filterTrust")}
          className="rounded-[10px] border border-line bg-paper px-3 py-2 text-[13px] text-ink"
          value={trust}
          onChange={(event) => setTrust(event.target.value as TrustFilter)}
        >
          <option value="all">{t("trustAll")}</option>
          <option value="trusted">{t("trustTrusted")}</option>
          <option value="untrusted">{t("trustUntrusted")}</option>
        </select>
      </div>

      {filtered.length > 0 ? (
        <ul className="flex list-none flex-col gap-2">
          {filtered.map((group) => (
            <li key={group.key}>
              <Link
                className="flex flex-col gap-2 rounded-[14px] border border-line bg-paper px-5 py-4 transition-colors hover:border-amber"
                href={`/studio/packages/${encodeURIComponent(group.name)}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink">
                    {group.name}
                  </span>
                  {group.isLocal ? (
                    <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                      {t("localBadge")}
                    </span>
                  ) : null}
                  <span className="font-mono text-[11px] text-mute">
                    {group.versions[0]?.versionLabel}
                  </span>
                  <span
                    className={
                      group.needsTrust
                        ? "ml-auto font-mono text-[11px] font-semibold text-amber"
                        : "ml-auto font-mono text-[11px] text-mute"
                    }
                  >
                    {group.needsTrust ? t("needsTrust") : t("trusted")}
                  </span>
                </div>
                <div className="truncate font-mono text-[11.5px] text-mute">
                  {group.sourceUrl}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {KIND_LABEL_KEYS.filter(
                    ({ key }) => group.counts[key] > 0,
                  ).map(({ key, label }) => (
                    <span
                      key={key}
                      className="rounded-full bg-ivory px-2 py-px font-mono text-[10.5px] text-ink-2"
                    >
                      {group.counts[key]} {t(label)}
                    </span>
                  ))}
                  <span className="ml-auto font-mono text-[10.5px] text-mute">
                    {t("usedBy", { count: group.attachedProjectCount })}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-mute">{t("packagesEmpty")}</p>
      )}
    </div>
  );
}
