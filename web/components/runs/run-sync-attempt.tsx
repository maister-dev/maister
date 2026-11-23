import type { ReactElement } from "react";
import type { RunSyncAttemptView } from "@/lib/runs/sync-panel-data";

import { useTranslations } from "next-intl";

export function RunSyncAttempt({
  attempt,
  timeline = false,
}: {
  attempt: RunSyncAttemptView;
  timeline?: boolean;
}): ReactElement {
  const t = useTranslations("workbenchGit.syncAttempt");
  const anchor = `sync-attempt-${attempt.attempt}`;
  const outcome =
    attempt.phase === "rebasing" ? attempt.strategy : attempt.phase;

  return (
    <section
      className="my-2 flex flex-col gap-1 rounded-md border border-line p-3 text-sm text-ink-2"
      id={timeline ? anchor : undefined}
      role="status"
    >
      <p className="m-0 font-medium">
        {t("title", { attempt: attempt.attempt })} · {t(`phase.${outcome}`)}
      </p>
      {attempt.targetRef ? (
        <p className="m-0 break-all">
          {t("target")} <code>{attempt.targetRef}</code>{" "}
          {attempt.targetSha ? (
            <code title={attempt.targetSha}>
              {attempt.targetSha.slice(0, 12)}
            </code>
          ) : null}
        </p>
      ) : null}
      {attempt.headShaBefore || attempt.headShaAfter ? (
        <p className="m-0">
          {t("head")}{" "}
          <code title={attempt.headShaBefore ?? undefined}>
            {attempt.headShaBefore?.slice(0, 12) ?? "—"}
          </code>
          {attempt.headShaAfter ? (
            <>
              {" "}
              →{" "}
              <code title={attempt.headShaAfter}>
                {attempt.headShaAfter.slice(0, 12)}
              </code>
            </>
          ) : null}
        </p>
      ) : null}
      {attempt.sessionName ? (
        <p className="m-0">
          {t("resolver")}{" "}
          {timeline ? (
            <code>{attempt.sessionName}</code>
          ) : (
            <a className="underline" href={`?wb=timeline#${anchor}`}>
              <code>{attempt.sessionName}</code>
            </a>
          )}
          {attempt.runnerId ? (
            <>
              {" "}
              · <code>{attempt.runnerId}</code>
            </>
          ) : null}
        </p>
      ) : null}
      {timeline && attempt.conflictedFiles?.length ? (
        <ul className="m-0 list-inside list-disc break-all">
          {attempt.conflictedFiles.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {attempt.settled ? (
        <p className="m-0">
          {t(attempt.pushed ? "pushed" : "notPushed")}
          {attempt.errorCode ? ` · ${attempt.errorCode}` : null}
        </p>
      ) : null}
    </section>
  );
}
