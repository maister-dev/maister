import type { ReactElement } from "react";

import Link from "next/link";
import { getTranslations } from "next-intl/server";

import {
  KnowledgeDate,
  KnowledgeUnavailable,
  knowledgePanelClass,
} from "@/components/brain/knowledge-view";
import { RunFindingsPanel } from "@/components/runs/run-findings-panel";
import { NativeInputInspectionPanel } from "@/components/runs/native-input-inspection";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { knowledgeReferenceView } from "@/lib/brain/knowledge-ui";
import { loadCompanyAssignmentInputForUser } from "@/lib/orchestrator/native-input-read";
import {
  loadRetainedResultForUser,
  retainedResultRevision,
} from "@/lib/run-results/retained-result";

export default async function RetainedResultPage({
  params,
}: {
  params: Promise<{ runId: string; revision: string }>;
}): Promise<ReactElement> {
  const user = await requireActiveSession();
  const { runId, revision } = await params;
  const t = await getTranslations("findings");
  const run = await getTranslations("run");
  const view = await knowledgeReferenceView(async () => {
    const input = await loadCompanyAssignmentInputForUser(
      getDb(),
      user.id,
      runId,
    );
    // Final result admission rechecks company input/source authority after assembling both views.
    const result = await loadRetainedResultForUser(getDb(), user.id, {
      runId,
      revision: retainedResultRevision(revision),
    });

    return result ? { result, input } : null;
  });

  if (view.state === "unavailable" || view.value === null)
    return <KnowledgeUnavailable />;
  const { result, input } = view.value;

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">{t("history")}</h1>
        <Link
          className="break-all text-sm underline"
          href={`/runs/${encodeURIComponent(runId)}`}
        >
          {runId}
        </Link>
        <p className="text-sm text-mute">{t("historical")}</p>
      </header>
      <dl
        className={`${knowledgePanelClass} grid gap-4 text-sm sm:grid-cols-2`}
      >
        <div>
          <dt className="text-mute">{t("revision")}</dt>
          <dd>{result.revision}</dd>
        </div>
        <div>
          <dt className="text-mute">{t("validity")}</dt>
          <dd>
            {result.validity === "superseded"
              ? run("publicResultSuperseded")
              : run(
                  `publicResultStatus${result.validity[0].toUpperCase()}${result.validity.slice(1)}`,
                )}
          </dd>
        </div>
        <div>
          <dt className="text-mute">{t("publishedAt")}</dt>
          <dd>
            <KnowledgeDate value={result.publishedAt} />
          </dd>
        </div>
        <div>
          <dt className="text-mute">{t("collectedAt")}</dt>
          <dd>
            {result.collectedAt ? (
              <KnowledgeDate value={result.collectedAt} />
            ) : (
              t("notCollected")
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-mute">{run("publicResultSchemaRef")}</dt>
          <dd className="break-all font-mono text-xs">
            {result.schemaRef}
            <p className="mt-1">SHA-256: {result.schemaSha256}</p>
          </dd>
        </div>
      </dl>
      {input ? <NativeInputInspectionPanel input={input} /> : null}
      {result.invalidReason ? (
        <p className={`${knowledgePanelClass} text-sm`} role="status">
          {run("publicResultFailureReason")}: {result.invalidReason}
        </p>
      ) : null}
      {result.findings ? <RunFindingsPanel findings={result.findings} /> : null}
      <details className={knowledgePanelClass}>
        <summary className="text-sm font-semibold">{t("value")}</summary>
        {result.value === null ? (
          <p className="mt-3 text-sm text-mute">{t("noValue")}</p>
        ) : (
          <pre className="mt-3 max-h-[65vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
            {JSON.stringify(result.value, null, 2)}
          </pre>
        )}
      </details>
    </div>
  );
}
