import type { AutonomousCompletionCounts as Counts } from "@/lib/queries/autonomous-completion";

import { getTranslations } from "next-intl/server";

export async function AutonomousCompletionCounts({
  counts,
}: {
  counts: Counts;
}) {
  const t = await getTranslations("observatory.autonomous");

  return (
    <section
      aria-label={t("title")}
      className="rounded-xl border border-line bg-paper p-4"
    >
      <h2 className="mb-2 text-sm font-semibold">{t("title")}</h2>
      <dl className="flex flex-wrap gap-6 text-sm">
        <div>
          <dt>{t("done")}</dt>
          <dd className="font-mono">{counts.done}</dd>
        </div>
        <div>
          <dt>{t("failed")}</dt>
          <dd className="font-mono">{counts.failed}</dd>
        </div>
        <div>
          <dt>{t("reverted")}</dt>
          <dd className="font-mono">{counts.reverted}</dd>
        </div>
      </dl>
    </section>
  );
}
