import type { ReactElement } from "react";

import clsx from "clsx";

export interface LogoProps {
  size?: number;
  className?: string;
}

export function Logo({ size = 22, className }: LogoProps): ReactElement {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2.5 font-semibold text-ink",
        "text-[18px] tracking-[-0.018em]",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        className="shrink-0 text-amber"
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        style={{ flex: `0 0 ${size}px` }}
        viewBox="0 0 28 24"
        width={size}
      >
        <path d="M22 12 a8 8 0 1 1 -2.34 -5.66" />
        <polyline points="22 5 22 9 18 9" />
        <line x1="14" x2="14" y1="2" y2="4.5" />
        <circle cx="14" cy="1.6" fill="currentColor" r="1" stroke="none" />
        <circle cx="11" cy="12" fill="currentColor" r="1.2" stroke="none" />
        <circle cx="16" cy="12" fill="currentColor" r="1.2" stroke="none" />
      </svg>
      <span className="font-sans font-semibold tracking-[-0.02em]">
        m<strong className="font-extrabold tracking-[-0.015em]">ai</strong>ster
      </span>
    </span>
  );
}
