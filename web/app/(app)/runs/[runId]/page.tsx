import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import { RunHitlResponse } from "@/components/board/run-hitl-response";
import { getProjectRole, getSessionUser } from "@/lib/authz";
import { getRunDetail } from "@/lib/queries/run";

type RouteParams = { params: Promise<{ runId: string }> };

export default async function RunDetailPage({
  params,
}: RouteParams): Promise<ReactElement> {
  const { runId } = await params;

  const user = await getSessionUser();

  if (!user) redirect("/login");

  const detail = await getRunDetail(runId);

  if (!detail) notFound();

  const role =
    user.role === "admin"
      ? "owner"
      : await getProjectRole(user.id, detail.projectId);

  // Hide existence from non-members (mirrors the project board page).
  if (!role) notFound();

  const canAct = role === "owner" || role === "admin" || role === "member";
  const t = await getTranslations("run");

  return (
    <div className="mx-auto max-w-[760px]">
      <Link
        className="font-mono text-[11px] text-mute hover:text-ink"
        href={`/projects/${detail.projectSlug}`}
      >
        {t("backToBoard")}
      </Link>

      <header className="mb-6 mt-3 border-b border-line pb-5">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute">
          {t("eyebrow")} · {detail.projectSlug}
        </div>
        <h1 className="mt-1 font-mono text-[20px] font-bold tracking-[-0.01em] text-ink">
          {detail.branch}
        </h1>
        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-mute">
          <span className="rounded-full border border-line bg-ivory px-2.5 py-1 text-ink-2">
            {detail.status}
          </span>
          <span>{detail.agent}</span>
          {detail.currentStepId ? (
            <span>
              {t("step")} · {detail.currentStepId}
            </span>
          ) : null}
        </div>
      </header>

      {detail.pendingHitl ? (
        <section className="rounded-[14px] border border-amber-line bg-[color-mix(in_oklab,var(--amber-soft)_45%,var(--paper))] p-5">
          <h2 className="mb-1 inline-flex items-center gap-2 font-sans text-[14px] font-bold tracking-[-0.01em] text-ink before:h-[7px] before:w-[7px] before:rounded-full before:bg-amber before:content-['']">
            {t("pendingTitle")}
          </h2>
          <p className="mb-4 text-[14px] leading-[1.4] text-ink">
            {detail.pendingHitl.prompt}
          </p>
          <RunHitlResponse
            canAct={canAct}
            hitlRequestId={detail.pendingHitl.hitlRequestId}
            kind={detail.pendingHitl.kind}
            options={detail.pendingHitl.options}
            runId={detail.runId}
            schema={detail.pendingHitl.schema}
          />
        </section>
      ) : (
        <p className="rounded-[14px] border border-dashed border-line p-6 text-center font-mono text-[12px] text-mute">
          {t("noPending")}
        </p>
      )}
    </div>
  );
}
