import type { Metadata } from "next";
import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { createAuthoredFlowAction } from "@/app/(app)/flows/actions";
import { requireSession } from "@/lib/authz";
import { getPlatformFlows } from "@/lib/queries/platform-flows";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("flows");

  return { title: t("newTitle") };
}

export default async function NewFlowPage(): Promise<ReactElement> {
  const user = await requireSession();
  const t = await getTranslations("flows");
  const view = await getPlatformFlows({
    userId: user.id,
    userRole: user.role,
  });
  const manageableProjects = view.projects.filter(
    (project) => project.canManageCatalog,
  );

  if (manageableProjects.length === 0) redirect("/flows");

  return (
    <div className="mx-auto w-full max-w-[680px]">
      <header className="mb-7">
        <Link
          className="mb-4 inline-flex font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-ink"
          href="/flows"
        >
          {t("backToFlows")}
        </Link>
        <div className="mb-2.5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-mute before:h-px before:w-[18px] before:bg-amber before:content-['']">
          {t("newEyebrow")}
        </div>
        <h1 className="m-0 text-[30px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
          {t("newTitle")}
        </h1>
        <p className="mt-1.5 max-w-[58ch] text-[13.5px] leading-[1.5] text-mute">
          {t("newSub")}
        </p>
      </header>

      <form
        action={createAuthoredFlowAction}
        className="rounded-xl border border-line bg-paper p-5"
      >
        <div className="grid grid-cols-1 gap-4">
          <label className="grid gap-1.5">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
              {t("project")}
            </span>
            <select
              required
              className="rounded-md border border-line bg-ivory px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-amber"
              name="projectSlug"
            >
              {manageableProjects.map((project) => (
                <option key={project.id} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
              {t("slug")}
            </span>
            <input
              required
              className="rounded-md border border-line bg-ivory px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-amber"
              name="slug"
              pattern="[a-z0-9][a-z0-9._-]*"
              placeholder="release-review"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-mute">
              {t("flowTitle")}
            </span>
            <input
              required
              className="rounded-md border border-line bg-ivory px-3 py-2.5 text-[13px] text-ink outline-none focus:border-amber"
              name="title"
              placeholder={t("titlePlaceholder")}
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Link
            className="rounded-md border border-line px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink-2 hover:bg-ivory"
            href="/flows"
          >
            {t("cancel")}
          </Link>
          <button
            className="rounded-md bg-ink px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-paper hover:bg-ink-2"
            type="submit"
          >
            {t("createDraft")}
          </button>
        </div>
      </form>
    </div>
  );
}
