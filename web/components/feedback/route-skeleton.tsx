import type { ReactElement } from "react";

export type RouteSkeletonVariant =
  | "portfolio"
  | "run"
  | "project"
  | "studio"
  | "inbox";

const linesByVariant: Record<RouteSkeletonVariant, number> = {
  portfolio: 6,
  run: 8,
  project: 7,
  studio: 9,
  inbox: 5,
};

export function RouteSkeleton({
  variant,
}: {
  variant: RouteSkeletonVariant;
}): ReactElement {
  return (
    <section
      aria-busy="true"
      className="mx-auto w-full max-w-[1440px] animate-pulse px-4 py-5 sm:px-6"
      data-testid={`route-skeleton-${variant}`}
    >
      <div className="h-5 w-32 rounded bg-line/60" />
      <div className="mt-3 h-8 w-64 max-w-full rounded bg-line/70" />
      <div className="mt-6 grid gap-3 lg:grid-cols-3">
        {Array.from({ length: linesByVariant[variant] }, (_, index) => (
          <div
            key={index}
            className="h-24 rounded-[12px] border border-line/60 bg-ivory"
          />
        ))}
      </div>
    </section>
  );
}
