import type { ReactElement } from "react";

type LogoProps = {
  compact?: boolean;
};

export function Logo({ compact = false }: LogoProps): ReactElement {
  return (
    <span className="brand-lockup">
      <svg
        aria-hidden="true"
        className="brand-mark"
        fill="none"
        viewBox="0 0 28 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M22 12a8 8 0 1 1-2.34-5.66" />
        <polyline points="22 5 22 9 18 9" />
        <line x1="14" x2="14" y1="2" y2="4.5" />
        <circle cx="14" cy="1.6" fill="currentColor" r="1" stroke="none" />
        <circle cx="11" cy="12" fill="currentColor" r="1.2" stroke="none" />
        <circle cx="16" cy="12" fill="currentColor" r="1.2" stroke="none" />
      </svg>
      {!compact ? (
        <span className="brand-wordmark">
          m<strong>ai</strong>ster
        </span>
      ) : null}
    </span>
  );
}
