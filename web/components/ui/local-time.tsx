"use client";

import type { ReactElement } from "react";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

function utcLabel(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// D11: one rendering of a stored UTC instant. The server (and the first client
// render) prints a locale-neutral UTC value labeled "UTC"; after hydration the
// viewer's own zone is shown with its name in the page language (<html lang>),
// so a pre-hydration value is never an unlabeled other time.
export function LocalTime({
  iso,
  testId,
}: {
  iso: string | Date | null;
  testId?: string;
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
        data-testid={testId}
        dateTime={at.toISOString()}
        title={utcLabel(at)}
      >
        {utcLabel(at)}
      </time>
    );
  }

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Intl.DateTimeFormat(
    document.documentElement.lang || undefined,
    {
      // dateStyle/timeStyle cannot be combined with timeZoneName.
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    },
  ).format(at);

  return (
    <time
      data-testid={testId}
      dateTime={at.toISOString()}
      title={`${local} (${zone})`}
    >
      {local}
    </time>
  );
}
