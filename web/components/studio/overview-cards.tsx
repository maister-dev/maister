"use client";

import type { PackageGroup } from "@/lib/studio/group-packages";
import type {
  StudioLocalSummary,
  StudioRecentLocalPackage,
  StudioSourceSummary,
} from "@/lib/studio/load";
import type { ReactElement } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRightIcon, ScissorsIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

import { readApiError } from "@/lib/api-error";

type Metric = { label: string; value: number };
type AreaCard = {
  href: string;
  title: string;
  sub: string;
  metrics: Metric[];
};
type AttentionItem = {
  href: string;
  title: string;
  sub: string;
  value: number;
  tone: "neutral" | "warning";
};

export function OverviewCards({
  groups,
  isAdmin,
  localSummary,
  recentLocalPackages,
  sourceSummary,
}: {
  groups: PackageGroup[];
  isAdmin: boolean;
  localSummary: StudioLocalSummary;
  recentLocalPackages: StudioRecentLocalPackage[];
  sourceSummary: StudioSourceSummary | null;
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [cuttingId, setCuttingId] = useState<string | null>(null);
  const [workNotice, setWorkNotice] = useState<string | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);

  const versionCount = groups.reduce(
    (sum, group) => sum + group.versions.length,
    0,
  );
  const artifactCount = groups.reduce(
    (sum, group) =>
      sum +
      group.counts.flows +
      group.counts.skills +
      group.counts.platformAgents +
      group.counts.subagents +
      group.counts.mcps +
      group.counts.rules,
    0,
  );
  const needsAttention = groups.filter((group) => group.needsTrust);

  const areas: AreaCard[] = [
    {
      href: "/studio/packages",
      title: t("packagesTitle"),
      sub: t("packagesSub"),
      metrics: [
        { label: t("overviewInstalledMetric"), value: groups.length },
        ...(sourceSummary
          ? [
              {
                label: t("overviewAvailableMetric"),
                value: sourceSummary.discoveredPackageCount,
              },
            ]
          : []),
        { label: t("overviewVersionsMetric"), value: versionCount },
        { label: t("overviewArtifactsMetric"), value: artifactCount },
      ],
    },
    {
      href: "/studio/local",
      title: t("localTitle"),
      sub: t("localSub"),
      metrics: [
        { label: t("overviewActiveMetric"), value: localSummary.activeCount },
        { label: t("overviewTotalMetric"), value: localSummary.totalCount },
        { label: t("overviewDraftsMetric"), value: localSummary.uncutCount },
        { label: t("overviewCutMetric"), value: localSummary.cutCount },
      ],
    },
  ];

  if (isAdmin && sourceSummary) {
    areas.push({
      href: "/studio/sources",
      title: t("sourcesTitle"),
      sub: t("sourcesSub"),
      metrics: [
        { label: t("overviewSourcesMetric"), value: sourceSummary.sourceCount },
        {
          label: t("overviewEnabledMetric"),
          value: sourceSummary.enabledSourceCount,
        },
        {
          label: t("overviewAvailableMetric"),
          value: sourceSummary.discoveredPackageCount,
        },
        {
          label: t("overviewTagsMetric"),
          value: sourceSummary.discoveredTagCount,
        },
      ],
    });
  }

  const attentionItems: AttentionItem[] = [
    {
      href: "/studio/packages",
      title: t("attentionTrustTitle"),
      sub:
        needsAttention.length > 0
          ? t("attentionTrustSub")
          : t("attentionTrustOk"),
      value: needsAttention.length,
      tone: needsAttention.length > 0 ? "warning" : "neutral",
    },
    {
      href: "/studio/local",
      title: t("attentionLocalTitle"),
      sub:
        localSummary.uncutCount > 0
          ? t("attentionLocalSub")
          : t("attentionLocalOk"),
      value: localSummary.uncutCount,
      tone: localSummary.uncutCount > 0 ? "warning" : "neutral",
    },
  ];

  async function cutVersion(id: string): Promise<void> {
    setCuttingId(id);
    setWorkNotice(null);
    setWorkError(null);

    try {
      const res = await fetch(`/api/studio/local-packages/${id}/cut-version`, {
        method: "POST",
      });

      if (!res.ok) {
        setWorkError(await readApiError(res, tApiErrors));

        return;
      }

      const cut = (await res.json()) as { versionLabel: string };

      setWorkNotice(t("continueWorkCutDone", { label: cut.versionLabel }));
      router.refresh();
    } catch (err) {
      setWorkError(err instanceof Error ? err.message : String(err));
    } finally {
      setCuttingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 md:grid-cols-3">
        {areas.map((area) => (
          <Link
            key={area.href}
            className="group flex min-h-[158px] flex-col justify-between gap-4 rounded-[14px] border border-line bg-paper px-5 py-4 transition-colors hover:border-amber"
            href={area.href}
          >
            <span className="flex items-start justify-between gap-3">
              <span className="flex flex-col gap-1.5">
                <span className="text-[15px] font-semibold text-ink">
                  {area.title}
                </span>
                <span className="text-[12.5px] leading-[1.45] text-mute">
                  {area.sub}
                </span>
              </span>
              <ArrowRightIcon className="mt-0.5 h-4 w-4 shrink-0 text-mute transition-colors group-hover:text-amber" />
            </span>
            <span className="grid grid-cols-2 gap-2">
              {area.metrics.map((metric) => (
                <span
                  key={`${area.href}:${metric.label}`}
                  className="rounded-[10px] border border-line/70 bg-ivory px-3 py-2"
                >
                  <span className="block text-[22px] font-semibold leading-none text-ink">
                    {metric.value}
                  </span>
                  <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-mute">
                    {metric.label}
                  </span>
                </span>
              ))}
            </span>
          </Link>
        ))}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
          {t("needsAttention")}
        </h2>
        <ul className="grid list-none gap-2 md:grid-cols-2">
          {attentionItems.map((item) => (
            <li key={item.title}>
              <Link
                className={
                  item.tone === "warning"
                    ? "flex items-center justify-between gap-4 rounded-[12px] border border-amber-line bg-amber-soft px-4 py-3 text-[13px] text-ink transition-colors hover:border-amber"
                    : "flex items-center justify-between gap-4 rounded-[12px] border border-line bg-paper px-4 py-3 text-[13px] text-ink transition-colors hover:border-amber"
                }
                href={item.href}
              >
                <span className="min-w-0">
                  <span className="block font-semibold">{item.title}</span>
                  <span className="mt-0.5 block text-[12px] leading-[1.35] text-mute">
                    {item.sub}
                  </span>
                </span>
                <span
                  className={
                    item.tone === "warning"
                      ? "font-mono text-[20px] font-semibold text-amber"
                      : "font-mono text-[20px] font-semibold text-mute"
                  }
                >
                  {item.value}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">
              {t("continueWorkTitle")}
            </h2>
            <p className="mt-1 text-[12.5px] leading-[1.45] text-mute">
              {t("continueWorkSub")}
            </p>
          </div>
          <Link
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
            href="/studio/local"
          >
            {t("continueWorkViewAll")}
          </Link>
        </div>

        {workError ? (
          <p
            className="rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
            role="alert"
          >
            {workError}
          </p>
        ) : null}

        {workNotice ? (
          <p
            className="rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12px] text-ink-2"
            role="status"
          >
            {workNotice}
          </p>
        ) : null}

        {recentLocalPackages.length > 0 ? (
          <ul className="flex list-none flex-col gap-2">
            {recentLocalPackages.map((pkg) => {
              const archived = pkg.status === "archived";

              return (
                <li
                  key={pkg.id}
                  className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-paper px-4 py-3 transition-colors hover:border-amber"
                >
                  <Link
                    className="min-w-[220px] flex-1 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    href={`/studio/edit/${encodeURIComponent(pkg.id)}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-ink">
                        {pkg.name}
                      </span>
                      <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                        {localPackageStatusLabel(pkg, t)}
                      </span>
                      {pkg.origin.kind === "forked" ? (
                        <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                          {t("continueWorkForked")}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-mute">
                      <span>{localPackageLineage(pkg, t)}</span>
                      <span>
                        {t("continueWorkUpdated", {
                          when: new Date(pkg.updatedAt).toLocaleString(),
                        })}
                      </span>
                    </div>
                  </Link>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      aria-label={t("continueWorkCut")}
                      className="rounded-[9px] border border-line bg-ivory p-2 text-ink-2 transition-colors hover:border-amber hover:text-ink disabled:opacity-50"
                      disabled={archived || cuttingId === pkg.id}
                      title={t("continueWorkCut")}
                      type="button"
                      onClick={() => void cutVersion(pkg.id)}
                    >
                      <ScissorsIcon className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-[14px] border border-line bg-paper px-4 py-3">
            <p className="m-0 text-[13px] leading-[1.45] text-mute">
              {t("continueWorkEmpty")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function localPackageStatusLabel(
  pkg: StudioRecentLocalPackage,
  t: (key: string) => string,
): string {
  if (pkg.status === "archived") return t("continueWorkArchived");
  if (pkg.lastCutInstallId) return t("continueWorkCutStatus");

  return t("continueWorkDraft");
}

function localPackageLineage(
  pkg: StudioRecentLocalPackage,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (pkg.origin.kind === "forked") {
    return t("local.originForked", {
      name: pkg.origin.packageName,
      version: pkg.origin.versionLabel,
    });
  }

  if (pkg.isDefault) return t("continueWorkProjectDefault");

  return t("local.originLocal");
}
