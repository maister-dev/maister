import type { ReactElement } from "react";

import Link from "next/link";

export type CutoverFailureBannerLabels = {
  evidence: string;
  history: string;
  reason: string;
  title: string;
  worktree: string;
};

export function CutoverFailureBanner({
  labels,
  locale,
  occurredAt,
  runId,
}: {
  labels: CutoverFailureBannerLabels;
  locale: string;
  occurredAt: Date;
  runId: string;
}): ReactElement {
  const timestamp = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(occurredAt);

  return (
    <section
      aria-labelledby="cutover-failure-title"
      className="rounded-[14px] border border-red-300 bg-red-50/70 p-5 text-red-950 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100"
      data-testid="run-cutover-failure"
      role="alert"
    >
      <h2 className="m-0 text-[14px] font-bold" id="cutover-failure-title">
        {labels.title}
      </h2>
      <p className="mt-2 text-[13px] leading-relaxed">{labels.reason}</p>
      <time
        className="mt-2 block font-mono text-[11px]"
        dateTime={occurredAt.toISOString()}
      >
        {timestamp}
      </time>
      <nav
        aria-label={labels.title}
        className="mt-4 flex flex-wrap gap-3 font-mono text-[11px] font-semibold"
      >
        <Link
          className="underline underline-offset-2"
          href={`/runs/${runId}?wb=timeline`}
        >
          {labels.history}
        </Link>
        <Link
          className="underline underline-offset-2"
          href={`/runs/${runId}?wb=evidence`}
        >
          {labels.evidence}
        </Link>
        <Link
          className="underline underline-offset-2"
          href={`/runs/${runId}?wb=files`}
        >
          {labels.worktree}
        </Link>
      </nav>
    </section>
  );
}
