import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import {
  getIncomingRequests,
  type IncomingFilter,
} from "@/lib/queries/incoming";

export async function IncomingRequests({
  projectId,
  slug,
  taskKey,
  page,
  state,
}: {
  projectId: string;
  slug: string;
  taskKey: string;
  page: number;
  state?: IncomingFilter;
}): Promise<ReactElement> {
  const t = await getTranslations("taskQualification");
  const result = await getIncomingRequests(projectId, page, state);
  const url = (number: number): string =>
    `/projects/${slug}?${new URLSearchParams({ tab: "incoming", page: String(number), ...(state ? { incoming_state: state } : {}) })}`;

  return (
    <section className="space-y-4" data-testid="incoming-requests">
      <h2 className="text-xl font-semibold">{t("incoming")}</h2>
      <p className="text-sm text-mute">{t("incomingHint")}</p>
      <form
        action={`/projects/${slug}`}
        className="flex items-center gap-3"
        method="get"
      >
        <input name="tab" type="hidden" value="incoming" />
        <label className="text-sm">
          {t("filter")}
          <select
            aria-label={t("filter")}
            className="ml-2 rounded-lg border border-line bg-paper p-2"
            defaultValue={state ?? ""}
            name="incoming_state"
          >
            <option value="">{t("allIncoming")}</option>
            {[
              "unassessed",
              "needs_information",
              "needs_review",
              "not_actionable",
            ].map((value) => (
              <option key={value} value={value}>
                {t(`decision.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-lg border border-line px-3 py-2 text-sm"
          type="submit"
        >
          {t("applyFilter")}
        </button>
      </form>
      {result.items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line bg-paper">
          {result.items.map((item) => (
            <li
              key={item.id}
              className="space-y-2 p-4"
              data-testid="incoming-request"
            >
              <Link
                className="font-semibold underline"
                href={`/projects/${slug}/tasks/${item.number}`}
              >
                {taskKey}-{item.number} · {item.title}
              </Link>
              <p className="text-sm text-mute">
                {t(`decision.${item.qualification.decision ?? "unassessed"}`)} ·{" "}
                {t(`freshness.${item.qualification.freshness}`)}
              </p>
              {item.qualification.candidate ? (
                <p className="text-xs text-mute">
                  {t(
                    `publication.${item.qualification.candidate.publicationState}`,
                  )}
                </p>
              ) : null}
              {item.qualification.nextActions.length ? (
                <ul className="list-disc pl-5 text-sm">
                  {item.qualification.nextActions.map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-line p-6 text-sm text-mute">
          {t("empty")}
        </p>
      )}
      <nav aria-label={t("pages")} className="flex gap-4 text-sm underline">
        {page > 1 ? <Link href={url(page - 1)}>{t("newer")}</Link> : null}
        {result.hasMore ? <Link href={url(page + 1)}>{t("older")}</Link> : null}
      </nav>
    </section>
  );
}
