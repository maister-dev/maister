import type { ReactElement } from "react";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { SpecialistAssignmentForm } from "@/components/specialist-assignments/assignment-form";
import { getProjectRole, requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";
import {
  listManualSpecialistChoices,
  listRequestedSpecialistAssignments,
} from "@/lib/specialist-assignments/workspace-view";
import { listStandTargets } from "@/lib/stand-operations/target-registry";

export default async function SpecialistAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("specialistAssignments");
  const { project: slug } = await searchParams;
  const project = slug ? await getProjectBySlug(slug) : null;

  if (
    slug &&
    (!project ||
      project.archivedAt ||
      (user.role !== "admin" && !(await getProjectRole(user.id, project.id))))
  )
    notFound();
  const db = getDb();
  const [choices, requested, targets] = await Promise.all([
    listManualSpecialistChoices(db, user.id, project?.id),
    listRequestedSpecialistAssignments(db, user.id, project?.id),
    listStandTargets(db, user.id, { limit: 50, enabledOnly: true })
      .then(({ items }) => items)
      .catch((error: unknown) => {
        if (isMaisterError(error) && error.code === "UNAUTHORIZED") return [];
        throw error;
      }),
  ]);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {slug ? (
          <Link href="/specialist-assignments">{t("companyAssignments")}</Link>
        ) : null}
      </header>
      {choices.length ? (
        <SpecialistAssignmentForm choices={choices} targets={targets} />
      ) : (
        <p className="rounded-xl border border-line bg-paper p-5 text-sm text-mute">
          {t("emptySpecialists")}
        </p>
      )}
      <div className="rounded-xl border border-line bg-paper">
        <h2 className="px-5 pt-4 text-base font-semibold">{t("requested")}</h2>
        {requested.length ? (
          <ul className="divide-y divide-line px-5">
            {requested.map((assignment) => (
              <li
                key={assignment.id}
                className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm"
              >
                <Link
                  className="font-medium"
                  href={`/specialist-assignments/${encodeURIComponent(assignment.id)}`}
                >
                  {assignment.objective}
                </Link>
                <span className="text-mute">
                  {t(`status.${assignment.status}`)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-4 text-sm text-mute">{t("emptyAssignments")}</p>
        )}
      </div>
    </section>
  );
}
