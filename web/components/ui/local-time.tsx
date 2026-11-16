"use client";

import type { ReactElement } from "react";

import { useLocale } from "next-intl";
import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

function utcLabel(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// D11: one rendering of a stored UTC instant. The server (and the first client
// render) prints a locale-neutral UTC value labeled "UTC"; after hydration the
// viewer's own zone is shown with its name in the current app locale,
// so a pre-hydration value is never an unlabeled other time.
export function LocalTime({
  iso,
  testId,
  className,
  displayText,
}: {
  iso: string | Date | null;
  testId?: string;
  className?: string;
  displayText?: string;
}): ReactElement {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  if (iso === null) return <span data-testid={testId}>—</span>;

  const at = typeof iso === "string" ? new Date(iso) : iso;

  if (!hydrated) {
    return (
      <time
        className={className}
        data-testid={testId}
        dateTime={at.toISOString()}
        title={utcLabel(at)}
      >
        {displayText ?? utcLabel(at)}
      </time>
    );
  }

  return (
    <BrowserLocalTime
      at={at}
      className={className}
      displayText={displayText}
      testId={testId}
    />
  );
}

function BrowserLocalTime({
  at,
  className,
  displayText,
  testId,
}: {
  at: Date;
  className?: string;
  displayText?: string;
  testId?: string;
}): ReactElement {
  const locale = useLocale();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Intl.DateTimeFormat(locale, {
    // dateStyle/timeStyle cannot be combined with timeZoneName.
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);

  return (
    <time
      className={className}
      data-testid={testId}
      dateTime={at.toISOString()}
      title={`${local} (${zone})`}
    >
      {displayText ?? local}
    </time>
  );
}
