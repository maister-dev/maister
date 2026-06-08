import type { Metadata } from "next";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireSession } from "@/lib/authz";
import {
  getPlatformFlows,
  parsePlatformFlowSearchParams,
} from "@/lib/queries/platform-flows";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("flows");

  return { title: t("title") };
}

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function FlowsPage({
  searchParams,
}: PageProps = {}): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("flows");
  const filters = parsePlatformFlowSearchParams((await searchParams) ?? {});
  const view = await getPlatformFlows({
    userId: user.id,
    userRole: user.role,
    filters,
  });
  const canCreate = view.projects.some((project) => project.canManageCatalog);

  return (
    <>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5 border-b border-line pb-6">
        <div>
          <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
            {t("eyebrow")}
          </div>
          <h1 className="m-0 text-[32px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
            {t("title")}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-[13.5px] leading-[1.5] text-mute">
            {t("sub")}
          </p>
        </div>
        {canCreate ? (
          <Link
            className="inline-flex items-center rounded-md bg-amber px-4 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-white transition-[transform,background] hover:-translate-y-px hover:bg-amber-2"
            href="/flows/new"
          >
            {t("newFlow")}
          </Link>
        ) : null}
      </header>

      <section className="mb-7 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-3">
        <Metric label={t("projects")} value={String(view.projects.length)} />
        <Metric label={t("authored")} value={String(view.authored.length)} />
        <Metric label={t("installed")} value={String(view.installed.length)} />
      </section>

      <form
        className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-line bg-paper p-4 md:grid-cols-[minmax(0,1fr)_220px_auto]"
        method="get"
      >
        <label className="grid gap-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("filterProject")}
          </span>
          <select
            className="rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
            defaultValue={filters.project}
            name="project"
          >
            <option value="all">{t("filterAllProjects")}</option>
            {view.projects.map((project) => (
              <option key={project.id} value={project.slug}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            {t("filterStatus")}
          </span>
          <select
            className="rounded-md border border-line bg-ivory px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-amber"
            defaultValue={filters.status}
            name="status"
          >
            <option value="all">{t("filterAllStatuses")}</option>
            <option value="draft">{t("lifecycle.DRAFT")}</option>
            <option value="published">{t("lifecycle.PUBLISHED")}</option>
            <option value="archived">{t("lifecycle.ARCHIVED")}</option>
            <option value="enabled">{t("enablement.Enabled")}</option>
            <option value="installed">{t("enablement.Installed")}</option>
            <option value="update-available">
              {t("enablement.UpdateAvailable")}
            </option>
            <option value="deprecated">{t("enablement.Deprecated")}</option>
            <option value="disabled">{t("enablement.Disabled")}</option>
            <option value="failed">{t("enablement.Failed")}</option>
            <option value="discovered">{t("packageStatus.Discovered")}</option>
            <option value="installing">{t("packageStatus.Installing")}</option>
            <option value="removed">{t("packageStatus.Removed")}</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            className="h-[38px] rounded-md bg-ink px-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-paper hover:bg-ink-2"
            type="submit"
          >
            {t("applyFilters")}
          </button>
        </div>
      </form>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
        <section>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="m-0 text-base font-bold text-ink">
              {t("authoredTitle")}
            </h2>
            <span className="font-mono text-[10.5px] text-mute">
              {t("authoredCount", { count: view.authored.length })}
            </span>
          </div>

          {view.authored.length === 0 ? (
            <EmptyPanel
              text={t(
                filters.status === "all"
                  ? "authoredEmpty"
                  : "authoredFilteredEmpty",
              )}
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
              {view.authored.map((flow) => (
                <Link
                  key={flow.id}
                  className="group rounded-xl border border-line bg-paper p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-mute hover:shadow-[var(--shadow-md)]"
                  href={`/flows/${flow.projectSlug}/${flow.id}`}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="m-0 truncate font-mono text-[14px] font-bold text-ink">
                        {flow.slug}
                      </h3>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-[1.45] text-mute">
                        {flow.title}
                      </p>
                    </div>
                    <StatusPill
                      label={t(`lifecycle.${flow.lifecycle}`)}
                      value={flow.lifecycle}
                    />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-dashed border-line-soft pt-3 font-mono text-[10.5px] text-mute">
                    <div>
                      <dt>{t("project")}</dt>
                      <dd className="m-0 truncate font-semibold text-ink-2">
                        {flow.projectName}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("draftVersion")}</dt>
                      <dd className="m-0 font-semibold text-ink-2">
                        {flow.draftVersion}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt>{t("hash")}</dt>
                      <dd className="m-0 truncate font-semibold text-ink-2">
                        {(
                          flow.draftContentHash ??
                          flow.publishedContentHash ??
                          "none"
                        ).slice(0, 16)}
                      </dd>
                    </div>
                  </dl>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="m-0 text-base font-bold text-ink">
              {t("installedTitle")}
            </h2>
            <span className="font-mono text-[10.5px] text-mute">
              {t("installedCount", { count: view.installed.length })}
            </span>
          </div>

          {view.installed.length === 0 ? (
            <EmptyPanel
              text={t(
                filters.status === "all"
                  ? "installedEmpty"
                  : "installedFilteredEmpty",
              )}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {view.installed.map((flow) => (
                <Link
                  key={flow.id}
                  className="rounded-xl border border-line bg-paper p-4 transition-[border-color,transform] hover:-translate-y-px hover:border-mute"
                  href={`/projects/${flow.projectSlug}?tab=packages`}
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="m-0 truncate font-mono text-[13px] font-bold text-ink">
                        {flow.ref}
                      </h3>
                      <p className="mt-1 truncate font-mono text-[10.5px] text-mute">
                        {flow.projectName}
                      </p>
                    </div>
                    <StatusPill
                      label={t(`enablement.${flow.enablementState}`)}
                      value={flow.enablementState}
                    />
                  </div>
                  <div className="space-y-1 border-t border-dashed border-line-soft pt-2.5 font-mono text-[10.5px] text-mute">
                    <div className="truncate">
                      {t("source")}:{" "}
                      <b className="font-semibold text-ink-2">{flow.source}</b>
                    </div>
                    <div>
                      {t("version")}:{" "}
                      <b className="font-semibold text-ink-2">
                        {flow.enabledVersionLabel ?? flow.version}
                      </b>
                    </div>
                    <div>
                      {t("trust")}:{" "}
                      <b className="font-semibold text-ink-2">
                        {t(`trust.${flow.trustStatus}`)}
                      </b>
                    </div>
                    {flow.packageStatus ? (
                      <div>
                        {t("packageStatusLabel")}:{" "}
                        <b className="font-semibold text-ink-2">
                          {t(`packageStatus.${flow.packageStatus}`)}
                        </b>
                      </div>
                    ) : null}
                    {flow.setupStatus ? (
                      <div>
                        {t("setupStatusLabel")}:{" "}
                        <b className="font-semibold text-ink-2">
                          {t(`setup.${flow.setupStatus}`)}
                        </b>
                      </div>
                    ) : null}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <div className="bg-paper px-4 py-3">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
        {label}
      </div>
      <div className="mt-1 text-[24px] font-semibold leading-none text-ink">
        {value}
      </div>
    </div>
  );
}

function StatusPill({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  const muted =
    value === "ARCHIVED" ||
    value === "Deprecated" ||
    value === "Disabled" ||
    value === "Failed" ||
    value === "Installed" ||
    value === "Removed";

  return (
    <span
      className={
        muted
          ? "shrink-0 rounded-full border border-line bg-paper px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-mute"
          : "shrink-0 rounded-full border border-amber-line bg-amber-soft px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-amber"
      }
    >
      {label}
    </span>
  );
}

function EmptyPanel({ text }: { text: string }): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-line bg-paper px-4 py-8 text-center font-mono text-[12px] text-mute">
      {text}
    </div>
  );
}
