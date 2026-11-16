import type { ReactElement } from "react";
import type { SpecialistAssignmentStatus } from "@/lib/specialist-assignments/types";

import { ChevronRightIcon, FunnelIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { SpecialistAssignmentForm } from "@/components/specialist-assignments/assignment-form";
import { AssignmentStatusPill } from "@/components/specialist-assignments/assignment-status-pill";
import { getProjectRole, requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";
import { listAccessibleSpecialistAssignments } from "@/lib/specialist-assignments/pages";
import { SPECIALIST_ASSIGNMENT_STATUSES } from "@/lib/specialist-assignments/types";
import { listManualSpecialistChoices } from "@/lib/specialist-assignments/workspace-view";
import { listStandTargets } from "@/lib/stand-operations/target-registry";

type SearchParams = {
  project?: string;
  status?: string;
  owner?: string;
  mine?: string;
  cursor?: string;
};

const pageSize = 25;

/** Every enabled target the form may cite, followed across keyset pages. */
async function listEnabledStandTargets(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<Awaited<ReturnType<typeof listStandTargets>>["items"]> {
  const items: Awaited<ReturnType<typeof listStandTargets>>["items"] = [];
  let cursor: string | null = null;

  do {
    const page = await listStandTargets(db, userId, {
      limit: 50,
      enabledOnly: true,
      ...(cursor ? { cursor } : {}),
    });

    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

function isStatus(
  value: string | undefined,
): value is SpecialistAssignmentStatus {
  return (
    value !== undefined &&
    (SPECIALIST_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

export default async function SpecialistAssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const t = await getTranslations("specialistAssignments");
  const format = await getFormatter();
  const query = await searchParams;
  const slug = query.project;
  const project = slug ? await getProjectBySlug(slug) : null;

  if (
    slug &&
    (!project ||
      project.archivedAt ||
      (user.role !== "admin" && !(await getProjectRole(user.id, project.id))))
  )
    notFound();
  const status = isStatus(query.status) ? query.status : undefined;
  const owner =
    query.owner === "company" || query.owner === "project"
      ? query.owner
      : undefined;
  const mine = query.mine === "1";
  const db = getDb();
  const [choices, page, targets] = await Promise.all([
    listManualSpecialistChoices(db, user.id, project?.id),
    listAccessibleSpecialistAssignments(
      db,
      user.id,
      {
        limit: pageSize,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
      {
        ...(project ? { projectId: project.id } : {}),
        ...(status ? { status } : {}),
        ...(owner ? { owner } : {}),
        ...(mine ? { requestedBy: user.id } : {}),
      },
    ).catch((error: unknown) => {
      // A cursor minted for other filters or an older authority starts over.
      if (isMaisterError(error) && error.code === "CONFIG" && query.cursor)
        return null;
      throw error;
    }),
    listEnabledStandTargets(db, user.id).catch((error: unknown) => {
      if (isMaisterError(error) && error.code === "UNAUTHORIZED") return [];
      throw error;
    }),
  ]);
  const filterHref = (cursor?: string) => {
    const params = new URLSearchParams();

    if (slug) params.set("project", slug);
    if (status) params.set("status", status);
    if (owner) params.set("owner", owner);
    if (mine) params.set("mine", "1");
    if (cursor) params.set("cursor", cursor);
    const value = params.toString();

    return value
      ? `/specialist-assignments?${value}`
      : "/specialist-assignments";
  };

  return (
    <section className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {slug ? (
          <Link className="text-sm underline" href="/specialist-assignments">
            {t("companyAssignments")}
          </Link>
        ) : null}
      </header>
      <details className="max-w-[760px] rounded-xl border border-line bg-paper p-5">
        <summary className="cursor-pointer font-semibold">
          {t("newAssignment")}
        </summary>
        <div className="mt-4">
          {choices.length ? (
            <SpecialistAssignmentForm choices={choices} targets={targets} />
          ) : (
            <p className="text-sm text-mute">{t("emptySpecialists")}</p>
          )}
        </div>
      </details>
      <form
        action="/specialist-assignments"
        className="flex flex-wrap items-end gap-3"
        method="get"
      >
        {slug ? <input name="project" type="hidden" value={slug} /> : null}
        <label className="text-sm">
          <span className="block text-mute">{t("filterStatus")}</span>
          <select
            className="mt-1 rounded-lg border border-line bg-paper px-3 py-2"
            defaultValue={status ?? ""}
            name="status"
          >
            <option value="">{t("filterAny")}</option>
            {SPECIALIST_ASSIGNMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {slug ? null : (
          <label className="text-sm">
            <span className="block text-mute">{t("owner")}</span>
            <select
              className="mt-1 rounded-lg border border-line bg-paper px-3 py-2"
              defaultValue={owner ?? ""}
              name="owner"
            >
              <option value="">{t("filterAny")}</option>
              <option value="company">{t("company")}</option>
              <option value="project">{t("project")}</option>
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input defaultChecked={mine} name="mine" type="checkbox" value="1" />
          {t("filterMine")}
        </label>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm"
          type="submit"
        >
          <FunnelIcon aria-hidden="true" className="size-4" />
          {t("applyFilters")}
        </button>
        {status || owner || mine ? (
          <Link
            className="pb-2 text-sm underline"
            href={
              slug
                ? `/specialist-assignments?project=${encodeURIComponent(slug)}`
                : "/specialist-assignments"
            }
          >
            {t("clearFilters")}
          </Link>
        ) : null}
      </form>
      {page === null ? (
        <p className="text-sm text-mute" role="status">
          {t("pageExpired")}{" "}
          <Link className="underline" href={filterHref()}>
            {t("firstPage")}
          </Link>
        </p>
      ) : page.items.length === 0 ? (
        <p className="rounded-xl border border-line bg-paper p-5 text-sm text-mute">
          {t(page.nextCursor ? "noVisibleOnPage" : "emptyAssignments")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table
            className="w-full min-w-[720px] text-left text-sm"
            data-testid="specialist-assignments-table"
          >
            <thead className="text-xs text-mute">
              <tr>
                <th className="px-4 py-3 font-normal">{t("objective")}</th>
                <th className="px-4 py-3 font-normal">{t("filterStatus")}</th>
                <th className="px-4 py-3 font-normal">{t("owner")}</th>
                <th className="px-4 py-3 font-normal">{t("updated")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {page.items.map((assignment) => (
                <tr key={assignment.id}>
                  <td className="px-4 py-3">
                    <Link
                      className="font-medium underline-offset-2 hover:underline"
                      href={`/specialist-assignments/${encodeURIComponent(assignment.id)}`}
                    >
                      {assignment.objective}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <AssignmentStatusPill
                      label={t(`status.${assignment.status}`)}
                      status={assignment.status}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {t(
                      assignment.owner.kind === "company"
                        ? "company"
                        : "project",
                    )}
                  </td>
                  <td suppressHydrationWarning className="px-4 py-3">
                    {format.dateTime(new Date(assignment.updatedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && (query.cursor || page.nextCursor) ? (
        <nav
          aria-label={t("pagination")}
          className="flex items-center justify-between text-sm"
        >
          {query.cursor ? (
            <Link className="underline" href={filterHref()}>
              {t("firstPage")}
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <Link
              className="inline-flex items-center gap-1 underline"
              href={filterHref(page.nextCursor)}
            >
              {t("nextPage")}
              <ChevronRightIcon aria-hidden="true" className="size-4" />
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
