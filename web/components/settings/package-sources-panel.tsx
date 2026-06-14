"use client";

import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  PackageSourceModal,
  type PackageSourceRow,
} from "@/components/settings/package-source-modal";

export type { PackageSourceRow };

export interface PackageInstallRow {
  id: string;
  sourceUrl: string;
  name: string;
  versionLabel: string;
  resolvedRevision: string;
  packageStatus: string;
  trustStatus: string;
  flows: string[];
}

type Props = {
  sources: PackageSourceRow[];
  installs: PackageInstallRow[];
};

const MAX_TAG_BUTTONS = 4;

// (ADR-088) Platform package catalog: sources CRUD + per-source discovery
// refresh + tag installs. View-only tables; edits live in the modal.
// installed_path is never part of the DTO.
export function PackageSourcesPanel({
  sources,
  installs,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PackageSourceRow | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());

  async function refreshSource(id: string): Promise<void> {
    setBusyKey(`refresh:${id}`);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/package-sources/${id}/refresh`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => null)) as {
        degraded?: boolean;
        message?: string;
      } | null;

      if (!res.ok) setNotice(body?.message ?? t("pkgRefreshFailed"));
      else if (body?.degraded) setNotice(t("pkgRefreshDegraded"));
      refresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function installTag(
    sourceId: string,
    name: string,
    version: string,
  ): Promise<void> {
    setBusyKey(`install:${name}@${version}`);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/package-installs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId, name, version }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;

        setNotice(body?.message ?? t("pkgInstallFailed"));
      }
      refresh();
    } finally {
      setBusyKey(null);
    }
  }

  const installedKeys = new Set(
    installs.map((i) => `${i.name}@${i.versionLabel}`),
  );

  return (
    <section className="mt-6 border-t border-line pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("pkgSourcesTitle")}
        </h3>
        <button
          className="h-10 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white hover:bg-amber-2"
          type="button"
          onClick={() => setCreating(true)}
        >
          {t("pkgSourceAdd")}
        </button>
      </div>

      {notice ? (
        <p
          className="mb-3 rounded-[8px] border border-amber/40 bg-amber/10 px-3 py-2 text-[12px] text-ink"
          role="alert"
        >
          {notice}
        </p>
      ) : null}

      {sources.length === 0 ? (
        <p className="m-0 text-[12px] leading-[1.5] text-mute">
          {t("pkgSourcesEmpty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="border-b border-line bg-ivory">
              <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{t("pkgColUrl")}</th>
                <th className="px-4 py-3">{t("colEnabled")}</th>
                <th className="px-4 py-3">{t("pkgColDiscovered")}</th>
                <th className="px-4 py-3">{t("pkgColChecked")}</th>
                <th className="px-4 py-3 text-right">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id} className="border-b border-line/60">
                  <td className="break-all px-4 py-3 font-mono text-[12.5px] text-ink">
                    {source.url}
                    {source.builtIn ? (
                      <span
                        className="ml-2 inline-block rounded-full border border-line bg-ivory px-2 py-0.5 align-middle font-mono text-[10px] uppercase tracking-[0.08em] text-mute"
                        title={t("pkgSourceBuiltInHint")}
                      >
                        {t("pkgSourceBuiltIn")}
                      </span>
                    ) : null}
                    {source.note ? (
                      <span className="block text-[11px] text-mute">
                        {source.note}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-[12.5px] text-ink">
                    {source.enabled ? t("yes") : t("no")}
                  </td>
                  <td className="px-4 py-3 text-[12.5px] text-ink">
                    {source.discovered.length}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11.5px] text-mute">
                    {source.lastCheckedAt
                      ? new Date(source.lastCheckedAt).toLocaleString()
                      : t("pkgNeverChecked")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-2">
                      <button
                        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory disabled:opacity-50"
                        disabled={busyKey === `refresh:${source.id}`}
                        type="button"
                        onClick={() => refreshSource(source.id)}
                      >
                        {t("pkgRefresh")}
                      </button>
                      <button
                        className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink hover:bg-ivory"
                        type="button"
                        onClick={() => setEditing(source)}
                      >
                        {t("edit")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sources.some((s) => s.discovered.length > 0) ? (
        <div className="mt-5">
          <h4 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
            {t("pkgCatalogTitle")}
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left">
              <thead className="border-b border-line bg-ivory">
                <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                  <th className="px-4 py-3">{t("pkgColPackage")}</th>
                  <th className="px-4 py-3">{t("pkgColVersions")}</th>
                </tr>
              </thead>
              <tbody>
                {sources.flatMap((source) =>
                  source.discovered.map((pkg) => (
                    <tr
                      key={`${source.id}:${pkg.name}`}
                      className="border-b border-line/60"
                    >
                      <td className="px-4 py-3 font-mono text-[12.5px] text-ink">
                        {pkg.name}
                      </td>
                      <td className="px-4 py-3">
                        {pkg.tags.length === 0 ? (
                          <span className="text-[12px] text-mute">
                            {t("pkgNoTags")}
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {pkg.tags.slice(0, MAX_TAG_BUTTONS).map((tag) => {
                              const installed = installedKeys.has(
                                `${pkg.name}@${tag}`,
                              );

                              return (
                                <button
                                  key={tag}
                                  className="h-8 rounded-[8px] border border-line px-3 font-mono text-[11.5px] text-ink hover:bg-ivory disabled:opacity-50"
                                  disabled={
                                    installed ||
                                    busyKey === `install:${pkg.name}@${tag}`
                                  }
                                  type="button"
                                  onClick={() =>
                                    installTag(source.id, pkg.name, tag)
                                  }
                                >
                                  {tag}
                                  {installed
                                    ? ` · ${t("pkgInstalled")}`
                                    : ` · ${t("pkgInstall")}`}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <h4 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
          {t("pkgInstallsTitle")}
        </h4>
        {installs.length === 0 ? (
          <p className="m-0 text-[12px] leading-[1.5] text-mute">
            {t("pkgInstallsEmpty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="border-b border-line bg-ivory">
                <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                  <th className="px-4 py-3">{t("pkgColPackage")}</th>
                  <th className="px-4 py-3">{t("pkgColVersion")}</th>
                  <th className="px-4 py-3">{t("pkgColRevision")}</th>
                  <th className="px-4 py-3">{t("colStatus")}</th>
                  <th className="px-4 py-3">{t("pkgColTrust")}</th>
                  <th className="px-4 py-3">{t("pkgColFlows")}</th>
                </tr>
              </thead>
              <tbody>
                {installs.map((install) => (
                  <tr key={install.id} className="border-b border-line/60">
                    <td className="px-4 py-3 font-mono text-[12.5px] text-ink">
                      {install.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12.5px] text-ink">
                      {install.versionLabel}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11.5px] text-mute">
                      {install.resolvedRevision.slice(0, 12)}
                    </td>
                    <td className="px-4 py-3 text-[12.5px] text-ink">
                      {install.packageStatus}
                    </td>
                    <td className="px-4 py-3 text-[12.5px] text-ink">
                      {install.trustStatus}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11.5px] text-mute">
                      {install.flows.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating ? (
        <PackageSourceModal
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}
      {editing ? (
        <PackageSourceModal
          mode="edit"
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}
