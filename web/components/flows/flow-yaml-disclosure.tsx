"use client";

import type { ReactElement } from "react";

import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

import { CodeEditor } from "@/components/flows/code-editor";

// The flow.yaml is collapsed by default (mirrors the Studio flow viewer's
// opt-in YAML toggle) — the graph above is the primary view; the raw manifest
// is revealed on click.
export function FlowYamlDisclosure({
  value,
  title,
  ariaLabel,
}: {
  value: string;
  title: string;
  ariaLabel: string;
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        aria-expanded={open}
        className="mb-3 inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-ivory px-3 py-1.5 font-sans text-[13px] font-semibold text-ink transition-colors hover:border-amber"
        data-testid="flow-yaml-toggle"
        type="button"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? (
          <ChevronDownIcon className="h-3.5 w-3.5" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5" />
        )}
        {title}
      </button>
      {open ? (
        <CodeEditor readOnly ariaLabel={ariaLabel} kind="flow" value={value} />
      ) : null}
    </div>
  );
}
