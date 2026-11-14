import type { ReactElement } from "react";

import Link from "next/link";

export type RunNextAction = Readonly<{
  label: string;
  href: string;
  reason?: string;
}>;

export function RunOutcome({
  heading,
  summary,
  next,
  noAction,
}: {
  heading: string;
  summary: string;
  next?: RunNextAction;
  noAction: string;
}): ReactElement {
  return (
    <section
      aria-labelledby="run-outcome"
      className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-paper px-3 py-2"
      data-testid="run-outcome"
    >
      <div className="min-w-0">
        <h2 className="text-xs font-semibold text-mute" id="run-outcome">
          {heading}
        </h2>
        <p className="break-words text-sm font-semibold text-ink">{summary}</p>
        {next?.reason ? (
          <p className="text-xs text-mute">{next.reason}</p>
        ) : null}
      </div>
      {next ? (
        <Link
          className="rounded-md border border-line px-2.5 py-1.5 text-sm font-semibold text-ink underline-offset-2 hover:underline"
          href={next.href}
        >
          {next.label}
        </Link>
      ) : (
        <p className="text-xs text-mute">{noAction}</p>
      )}
    </section>
  );
}
