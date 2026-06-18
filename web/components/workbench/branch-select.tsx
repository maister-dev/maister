"use client";

import type { ChangeEvent, ReactElement } from "react";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface BranchSelectProps {
  branches: string[];
  current: string;
  defaultBranch: string;
  label: string;
}

// Searchable branch picker for the project repo tab: a native <input> backed by
// a <datalist> gives free typeahead/filtering without a brittle popover combobox
// (matching the model-field precedent). Choosing a branch is a URL navigation
// (?ref=<branch>) that clears ?file= (the path may not exist on the new branch)
// and canonicalizes the default branch by omitting ?ref. Only an exact branch
// match navigates, so partial typing does nothing.
export function BranchSelect({
  branches,
  current,
  defaultBranch,
  label,
}: BranchSelectProps): ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listId = useId();

  function onChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value;

    if (next === current || !branches.includes(next)) return;

    const params = new URLSearchParams(searchParams.toString());

    params.set("tab", "repo");
    params.delete("file");

    if (next === defaultBranch) params.delete("ref");
    else params.set("ref", next);

    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <label className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute">
      {label}
      <input
        key={current}
        aria-label={label}
        autoComplete="off"
        className="w-[210px] rounded-[6px] border border-line bg-paper px-2 py-1 font-mono text-[11px] font-normal normal-case tracking-normal text-ink-2 outline-none focus:border-amber"
        defaultValue={current}
        list={listId}
        spellCheck={false}
        type="text"
        onChange={onChange}
      />
      <datalist id={listId}>
        {branches.map((branch) => (
          <option key={branch} value={branch} />
        ))}
      </datalist>
    </label>
  );
}
