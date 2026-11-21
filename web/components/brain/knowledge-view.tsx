import type { ReactElement, ReactNode } from "react";
import type {
  KnowledgeRecordEvidenceSummary,
  KnowledgeWitnessDto,
} from "@/lib/brain/knowledge-read-types";
import type { KnowledgeAttribution } from "@/lib/brain/record-types";
import type { Owner } from "@/lib/company/types";

import Link from "next/link";
import { getTranslations, getFormatter } from "next-intl/server";

export const knowledgePanelClass = "rounded-xl border border-line bg-paper p-5";
export const knowledgeFieldClass =
  "block w-full rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-amber";

export async function KnowledgeHeader({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}): Promise<ReactElement> {
  const t = await getTranslations("knowledge");

  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-mute">
          {t("eyebrow")}
        </p>
        <h1 className="break-words text-[28px] font-semibold tracking-[-0.025em] text-ink">
          {title ?? t("title")}
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-mute">{t("subtitle")}</p>
      </div>
      <nav
        aria-label={t("navigation")}
        className="flex flex-wrap gap-4 text-sm text-ink"
      >
        <Link href="/knowledge">{t("records")}</Link>
        <Link href="/knowledge/reviews">{t("reviewWorkspace")}</Link>
        {children}
      </nav>
    </header>
  );
}

export async function KnowledgeUnavailable(): Promise<ReactElement> {
  const t = await getTranslations("knowledge");

  return (
    <>
      <KnowledgeHeader />
      <section className={knowledgePanelClass}>
        <h2 className="font-semibold text-ink">{t("unavailableTitle")}</h2>
        <p className="mt-2 text-sm text-mute" role="status">
          {t("unavailableBody")}
        </p>
      </section>
    </>
  );
}

export async function KnowledgeOwner({
  owner,
}: {
  owner: Owner;
}): Promise<ReactElement> {
  const t = await getTranslations("knowledge");

  return (
    <span>
      {owner.kind === "company" ? t("company") : t("project")}
      <span className="ml-2 break-all font-mono text-[11px] text-mute">
        {owner.kind === "company" ? owner.companyId : owner.projectId}
      </span>
    </span>
  );
}

export async function KnowledgeActor({
  actor,
}: {
  actor: KnowledgeAttribution;
}): Promise<ReactElement> {
  const t = await getTranslations("knowledge");

  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {t(`actor.${actor.kind}`)}
      <span className="break-all font-mono text-[11px]">
        {actor.id ?? t("unknown")}
      </span>
      {actor.runId ? (
        <Link
          className="underline"
          href={`/runs/${encodeURIComponent(actor.runId)}`}
        >
          {t("originatingWork")}
        </Link>
      ) : null}
      {actor.attemptId ? (
        <span className="font-mono text-[11px]">
          {t("attempt")}: {actor.attemptId}
        </span>
      ) : null}
    </span>
  );
}

export async function KnowledgeDate({
  value,
}: {
  value: string | null;
}): Promise<ReactElement> {
  const t = await getTranslations("knowledge");
  const format = await getFormatter();

  return value === null ? (
    <span>{t("unknown")}</span>
  ) : (
    <time dateTime={value} title={value}>
      {format.dateTime(new Date(value), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      })}{" "}
      UTC
    </time>
  );
}

export async function KnowledgeEvidence({
  evidence,
}: {
  evidence: readonly KnowledgeRecordEvidenceSummary[];
}): Promise<ReactElement> {
  const t = await getTranslations("knowledge");

  return (
    <section className={knowledgePanelClass}>
      <h2 className="mb-3 text-base font-semibold text-ink">{t("evidence")}</h2>
      {evidence.length === 0 ? (
        <p className="text-sm text-mute">{t("noEvidence")}</p>
      ) : (
        <ul className="space-y-3">
          {evidence.map((entry, index) => (
            <li
              key={
                "witness" in entry
                  ? `${entry.relation}:${entry.witness.id}`
                  : `unavailable:${index}`
              }
              className="border-l-2 border-line pl-3 text-sm"
            >
              <p>
                {t(`relation.${entry.relation}`)} ·{" "}
                {t(
                  `state.${"witness" in entry ? entry.witness.availability : entry.unavailable.state}`,
                )}
              </p>
              {"witness" in entry ? (
                <>
                  <p className="my-1 break-all font-mono text-[11px] text-mute">
                    {entry.witness.sourceVersion ?? t("unknown")}
                  </p>
                  <Link
                    className="underline"
                    href={`/knowledge/witnesses/${encodeURIComponent(entry.witness.id)}`}
                  >
                    {t("inspectEvidence")}
                  </Link>
                </>
              ) : (
                <p className="mt-1 text-mute">
                  {t(`evidenceDiagnostic.${entry.unavailable.reasonCode}`)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export async function KnowledgeWitnessView({
  witness,
}: {
  witness: KnowledgeWitnessDto;
}): Promise<ReactElement> {
  const t = await getTranslations("knowledge");

  return (
    <>
      <KnowledgeHeader title={t("evidence")} />
      <section className={knowledgePanelClass}>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          {[
            ["identity", witness.id],
            ["sourceIdentity", witness.sourceId ?? t("unknown")],
            ["sourceSelector", witness.selector],
            ["sourceVersion", witness.sourceVersion ?? t("unknown")],
            ["digest", witness.sha256 ?? t("unknown")],
            ["availability", t(`state.${witness.availability}`)],
            ["independenceGroup", witness.independenceGroupId ?? t("unknown")],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-mute">{t(label)}</dt>
              <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
            </div>
          ))}
          <div>
            <dt className="text-mute">{t("submittedBy")}</dt>
            <dd>
              <KnowledgeActor actor={witness.attribution} />
            </dd>
          </div>
          <div>
            <dt className="text-mute">{t("capturedAt")}</dt>
            <dd>
              <KnowledgeDate value={witness.capturedAt} />
            </dd>
          </div>
          <div>
            <dt className="text-mute">{t("observedAt")}</dt>
            <dd>
              <KnowledgeDate value={witness.observedAt} />
            </dd>
          </div>
          <div>
            <dt className="text-mute">{t("sourceAt")}</dt>
            <dd>
              <KnowledgeDate value={witness.sourceAt} />
            </dd>
          </div>
        </dl>
        {witness.excerpt === null ? (
          <p className="mt-5 text-sm text-mute">{t("noExcerpt")}</p>
        ) : (
          <pre className="mt-5 whitespace-pre-wrap break-words rounded-lg border border-line bg-ivory p-4 text-[13px] leading-6 text-ink">
            {witness.excerpt}
          </pre>
        )}
        {witness.excerptTruncated ? (
          <p className="mt-2 text-sm text-mute">{t("excerptTruncated")}</p>
        ) : null}
      </section>
    </>
  );
}
