"use client";

import type { KeyboardEvent, ReactElement } from "react";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface BranchSelectProps {
  branches: string[];
  current: string;
  defaultBranch: string;
  label: string;
}

// Searchable branch picker for the project repo tab. A hand-rolled combobox
// (not a native <datalist>, which won't reliably reveal options on an empty or
// freshly focused field): focusing opens a dropdown of all branches, typing
// filters it, and choosing one is a URL navigation (?ref=<branch>) that clears
// ?file= (the path may not exist on the new branch) and omits ?ref for the
// default branch. The popover-in-modal caveat behind the model field does not
// apply here — the repo tab header is not a modal. The parent keys this by
// `current`, so a landed navigation remounts it with the new branch as value.
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
  const containerRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(current);
  const [activeIndex, setActiveIndex] = useState(0);

  // Until the user types a real filter, show the full list; an empty field also
  // shows everything. `query === current` covers the just-focused state where
  // the field still displays the active branch.
  const filtered =
    query.trim() === "" || query === current
      ? branches
      : branches.filter((branch) =>
          branch.toLowerCase().includes(query.toLowerCase()),
        );

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent): void {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);

    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function choose(branch: string): void {
    setOpen(false);

    if (branch === current) return;

    const params = new URLSearchParams(searchParams.toString());

    params.set("tab", "repo");
    params.delete("file");

    if (branch === defaultBranch) params.delete("ref");
    else params.set("ref", branch);

    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();

      if (!open) {
        setOpen(true);

        return;
      }
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && filtered[activeIndex]) {
        event.preventDefault();
        choose(filtered[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-mute"
    >
      {label}
      <div className="relative">
        <input
          aria-activedescendant={
            open && filtered[activeIndex]
              ? `${listId}-${activeIndex}`
              : undefined
          }
          aria-controls={listId}
          aria-expanded={open}
          aria-label={label}
          autoComplete="off"
          className="w-[210px] rounded-[6px] border border-line bg-paper px-2 py-1 font-mono text-[11px] font-normal normal-case tracking-normal text-ink-2 outline-none focus:border-amber"
          role="combobox"
          spellCheck={false}
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={(event) => {
            setOpen(true);
            event.target.select();
          }}
          onKeyDown={onKeyDown}
        />
        {open && filtered.length > 0 ? (
          <ul
            className="absolute left-0 top-full z-20 mt-1 max-h-[260px] w-[240px] overflow-auto rounded-[8px] border border-line bg-paper py-1 shadow-lg"
            id={listId}
            role="listbox"
          >
            {filtered.map((branch, index) => (
              <li key={branch} role="none">
                <button
                  aria-selected={branch === current}
                  className={`flex w-full items-center px-2.5 py-1 text-left font-mono text-[11px] font-normal normal-case tracking-normal hover:bg-ivory ${
                    index === activeIndex ? "bg-ivory" : ""
                  } ${branch === current ? "font-semibold text-ink" : "text-ink-2"}`}
                  id={`${listId}-${index}`}
                  role="option"
                  type="button"
                  onClick={() => choose(branch)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  {branch}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
