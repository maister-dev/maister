"use client";

import type { ReactElement } from "react";

import { PlusIcon } from "@heroicons/react/24/outline";

// Shared primary "Add" button for the /settings panels (runners, sidecars,
// webhooks) so they render at one size/style with a leading plus icon. The
// visible label is the accessible name.
export function AddButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      className="inline-flex h-10 items-center gap-1.5 rounded-[8px] border border-amber bg-amber px-4 text-[13px] font-semibold text-white hover:bg-amber-2 disabled:opacity-50"
      disabled={disabled}
      type="button"
      onClick={onClick}
    >
      <PlusIcon aria-hidden="true" className="h-4 w-4" />
      {label}
    </button>
  );
}
