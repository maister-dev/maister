import type { ReactElement } from "react";
import type { EvidenceFindingsV1 } from "@/lib/run-results/findings-types";
import type { KnowledgeReference } from "@/lib/brain/knowledge-types";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** Links name exact retained identities; each destination rechecks current source authority. */
function evidenceHref(reference: KnowledgeReference): string | null {
  const id = encodeURIComponent(reference.id);

  if (reference.kind === "knowledge" && reference.revision !== undefined)
    return `/knowledge/${id}?revision=${reference.revision}`;
  if (reference.kind === "witness") return `/knowledge/witnesses/${id}`;
  if (reference.kind === "result" && reference.revision !== undefined)
    return `/knowledge/results/${id}/${reference.revision}`;

  return null;
}

export async function RunFindingsPanel({
  findings,
  resultHref,
}: {
  findings: EvidenceFindingsV1;
  resultHref?: string;
}): Promise<ReactElement> {
  const t = await getTranslations("findings");
  const knowledge = await getTranslations("knowledge");
  const references = (items: readonly KnowledgeReference[]): ReactElement => (
    <ul className="space-y-2 text-xs">
      {items.map((reference, index) => {
        const href = evidenceHref(reference);
        const identity = `${reference.kind}:${reference.id}${reference.revision === undefined ? "" : `@${reference.revision}`}`;

        return (
          <li key={`${identity}:${index}`} className="break-all">
            {href ? (
              <Link className="underline" href={href}>
                {identity}
              </Link>
            ) : (
              <span>{t("unavailable")}</span>
            )}
            {reference.version ? (
              <p className="mt-1 text-mute">
                {t("sourceVersion")}: {reference.version}
              </p>
            ) : null}
            {reference.sha256 ? (
              <p className="mt-1 font-mono text-mute">
                SHA-256: {reference.sha256}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <section
      aria-label={t("title")}
      className="space-y-4 rounded-lg border border-line bg-paper p-4"
      data-testid="native-findings"
    >
      <h3 className="font-semibold">{t("title")}</h3>
      {resultHref ? (
        <Link className="text-xs underline" href={resultHref}>
          {t("history")}
        </Link>
      ) : null}
      <p className="text-xs text-mute">{t("confirmationPolicy")}</p>
      {findings.findings.length === 0 ? (
        <p className="text-sm text-mute">{t("empty")}</p>
      ) : null}
      <ol className="space-y-5">
        {findings.findings.map((finding) => (
          <li
            key={finding.id}
            className="space-y-3 border-t border-line pt-4"
            id={`finding-${encodeURIComponent(finding.id)}`}
          >
            <h4 className="whitespace-pre-wrap break-words font-medium">
              {finding.assertion}
            </h4>
            <p className="text-xs text-mute">
              {knowledge("basis")}: {knowledge(`state.${finding.basis}`)}
            </p>
            {finding.supporting.length > 0 ? (
              <div className="space-y-2">
                <h5 className="text-sm font-semibold">{t("supporting")}</h5>
                {references(finding.supporting)}
              </div>
            ) : null}
            {finding.contradicting.length > 0 ? (
              <div className="space-y-2">
                <h5 className="text-sm font-semibold">{t("contradicting")}</h5>
                {references(finding.contradicting)}
              </div>
            ) : null}
            {finding.supporting.length === 0 &&
            finding.contradicting.length === 0 ? (
              <p className="text-sm text-mute">{t("noReferences")}</p>
            ) : null}
            {finding.missingEvidence.length > 0 ? (
              <div>
                <h5 className="text-sm font-semibold">{t("missing")}</h5>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                  {finding.missingEvidence.map((missing, index) => (
                    <li key={index}>
                      {knowledge(`state.${missing.state}`)}: {missing.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {finding.limitations.length > 0 ? (
              <div>
                <h5 className="text-sm font-semibold">
                  {knowledge("limitations")}
                </h5>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                  {finding.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {finding.openQuestions.length > 0 ? (
              <div>
                <h5 className="text-sm font-semibold">{t("questions")}</h5>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                  {finding.openQuestions.map((question, index) => (
                    <li key={index}>{question}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {finding.sourceFindings.length > 0 ? (
              <div>
                <h5 className="text-sm font-semibold">{t("origins")}</h5>
                <ul className="mt-2 space-y-1 text-xs">
                  {finding.sourceFindings.map((source, index) => (
                    <li key={index}>
                      <Link
                        className="break-all underline"
                        href={`/knowledge/results/${encodeURIComponent(source.childRunId)}/${source.resultRevision}#finding-${encodeURIComponent(source.findingId)}`}
                      >
                        {source.childRunId}@{source.resultRevision} ·{" "}
                        {source.findingId}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {findings.selection.length > 0 ? (
        <details className="border-t border-line pt-3">
          <summary className="text-sm font-semibold">{t("selection")}</summary>
          <ul className="mt-3 space-y-2 text-xs">
            {findings.selection.map((selection, index) => (
              <li key={index}>
                <Link
                  className="break-all underline"
                  href={`/knowledge/results/${encodeURIComponent(selection.childRunId)}/${selection.resultRevision}#finding-${encodeURIComponent(selection.findingId)}`}
                >
                  {selection.childRunId}@{selection.resultRevision} ·{" "}
                  {selection.findingId}
                </Link>
                <p>
                  {t(selection.disposition)}
                  {selection.reason ? `: ${selection.reason}` : ""}
                </p>
                {selection.outputFindingIds.length > 0 ? (
                  <ul className="mt-1">
                    {selection.outputFindingIds.map((id) => (
                      <li key={id}>
                        <a
                          className="underline"
                          href={`#finding-${encodeURIComponent(id)}`}
                        >
                          {id}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {findings.knowledgeProposals.length > 0 ? (
        <details className="border-t border-line pt-3">
          <summary className="text-sm font-semibold">{t("proposals")}</summary>
          <p className="mt-2 text-xs text-mute">{t("proposalPolicy")}</p>
          <ul className="mt-3 space-y-3">
            {findings.knowledgeProposals.map((proposal, index) => (
              <li key={index}>
                <h4 className="font-medium">{proposal.title}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {proposal.assertion}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
