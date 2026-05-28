import type { ReactElement, ReactNode } from "react";

export interface LiveTickerProps {
  children: ReactNode;
}

export function LiveTicker({ children }: LiveTickerProps): ReactElement {
  return (
    <div className="mb-4 flex items-center gap-2.5 overflow-hidden rounded-full border border-line-soft bg-paper px-3.5 py-2 font-mono text-[11px] tracking-[0.02em] text-mute">
      <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.12em] text-accent-4">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]" />
        live
      </span>
      <span className="flex-1 overflow-hidden whitespace-nowrap [font-feature-settings:'calt'_0]">
        {children}
      </span>
    </div>
  );
}
