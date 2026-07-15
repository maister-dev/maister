"use client";

import type { FormEvent, ReactElement } from "react";

import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";

interface BrainMemorySearchProps {
  slug: string;
  query: string;
  placeholder: string;
  action: string;
}

const searchButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-amber bg-amber px-3 font-mono text-[10.5px] font-bold uppercase leading-none tracking-[0.06em] text-white shadow-[0_4px_12px_-6px_var(--amber)] transition-colors hover:bg-amber-2 focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--amber-soft)]";

export function projectBrainSearchHref(slug: string, query: string): string {
  const params = new URLSearchParams({ tab: "brain" });
  const trimmedQuery = query.trim();

  if (trimmedQuery) params.set("brain_query", trimmedQuery);

  return `/projects/${encodeURIComponent(slug)}?${params.toString()}`;
}

export function BrainMemorySearch({
  slug,
  query,
  placeholder,
  action,
}: BrainMemorySearchProps): ReactElement {
  const router = useRouter();
  const href = `/projects/${encodeURIComponent(slug)}`;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const rawQuery = formData.get("brain_query");
    const searchQuery = typeof rawQuery === "string" ? rawQuery : "";

    router.replace(projectBrainSearchHref(slug, searchQuery), {
      scroll: false,
    });
  }

  return (
    <form
      action={href}
      className="flex min-w-[260px] flex-1 justify-end gap-2"
      data-testid="brain-memory-search"
      method="get"
      onSubmit={onSubmit}
    >
      <input name="tab" type="hidden" value="brain" />
      <input
        aria-label={placeholder}
        className="h-9 min-w-0 flex-1 rounded-md border border-line bg-canvas px-3 text-[12px] text-ink outline-none md:max-w-[360px]"
        defaultValue={query}
        name="brain_query"
        placeholder={placeholder}
      />
      <button className={searchButtonClass} type="submit">
        <MagnifyingGlassIcon aria-hidden="true" className="h-3.5 w-3.5" />
        {action}
      </button>
    </form>
  );
}
