"use client";

import type { ReactElement, ReactNode } from "react";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

import { isGitPanelSection } from "@/lib/workbench-git/panel-link";

export function RunReviewDisclosure({
  collapsed,
  advanced = false,
  label,
  children,
}: {
  collapsed: boolean;
  advanced?: boolean;
  label: string;
  children?: ReactNode;
}): ReactElement {
  const params = useSearchParams();
  const section = params.get("git");
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (advanced && isGitPanelSection(section) && ref.current) {
      ref.current.open = true;
    }
  }, [advanced, section]);

  if (!collapsed) return <>{children}</>;

  return (
    <details
      ref={ref}
      className="min-w-0 rounded-lg border border-line bg-ivory p-4"
    >
      <summary className="cursor-pointer text-[13px] font-semibold text-ink-2">
        {label}
      </summary>
      <div className="mt-4 grid min-w-0 gap-5">{children}</div>
    </details>
  );
}
