"use client";

import type { ReactElement, ReactNode } from "react";

import { ChevronRightIcon } from "@heroicons/react/24/outline";
import clsx from "clsx";
import { useState } from "react";

// D10: heavy sections (flow graph, diff) mount only once opened, so their data
// loads and live subscriptions never run for a reader who does not look.
export function LazyDisclosure({
  summary,
  testId,
  children,
}: {
  summary: string;
  testId: string;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex flex-col gap-2">
      <button
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 self-start text-[12px] font-semibold uppercase tracking-[0.08em] text-mute hover:text-amber"
        data-testid={`${testId}-toggle`}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={clsx(
            "h-3.5 w-3.5 transition-transform",
            open && "rotate-90",
          )}
        />
        {summary}
      </button>
      {open ? <div data-testid={testId}>{children}</div> : null}
    </section>
  );
}
