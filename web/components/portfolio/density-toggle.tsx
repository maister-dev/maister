"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import clsx from "clsx";

type Density = "comfy" | "compact" | "list";

export interface DensityToggleProps {
  comfyLabel: string;
  compactLabel: string;
  listLabel: string;
}

const icons: Record<Density, ReactElement> = {
  comfy: (
    <>
      <rect height="5" rx="1" width="5" x="2" y="2" />
      <rect height="5" rx="1" width="5" x="9" y="2" />
      <rect height="5" rx="1" width="5" x="2" y="9" />
      <rect height="5" rx="1" width="5" x="9" y="9" />
    </>
  ),
  compact: (
    <>
      <rect height="3" rx="0.5" width="3" x="2" y="2" />
      <rect height="3" rx="0.5" width="3" x="7" y="2" />
      <rect height="3" rx="0.5" width="2" x="12" y="2" />
      <rect height="3" rx="0.5" width="3" x="2" y="7" />
      <rect height="3" rx="0.5" width="3" x="7" y="7" />
      <rect height="3" rx="0.5" width="2" x="12" y="7" />
    </>
  ),
  list: <path d="M2 4h12M2 8h12M2 12h12" />,
};

function setDensity(density: Density): void {
  const shell = document.querySelector<HTMLElement>("[data-shell]");

  if (shell) shell.dataset.density = density;
}

export function DensityToggle({
  comfyLabel,
  compactLabel,
  listLabel,
}: DensityToggleProps): ReactElement {
  const [active, setActive] = useState<Density>("comfy");

  const options: { id: Density; label: string }[] = [
    { id: "comfy", label: comfyLabel },
    { id: "compact", label: compactLabel },
    { id: "list", label: listLabel },
  ];

  return (
    <div
      aria-label="Density"
      className="inline-flex gap-0.5 rounded-full border border-line bg-ivory p-[3px]"
      role="tablist"
    >
      {options.map((option) => (
        <button
          key={option.id}
          aria-pressed={active === option.id}
          className={clsx(
            "inline-flex items-center gap-[5px] rounded-full px-3 py-1.5 font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[0.06em] transition-colors",
            active === option.id
              ? "bg-paper text-ink shadow-[0_1px_0_rgba(0,0,0,0.04),0_2px_6px_-2px_rgba(0,0,0,0.08)]"
              : "text-mute hover:text-ink",
          )}
          title={option.label}
          type="button"
          onClick={() => {
            setActive(option.id);
            setDensity(option.id);
          }}
        >
          <svg
            aria-hidden="true"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            viewBox="0 0 16 16"
          >
            {icons[option.id]}
          </svg>
          {option.label}
        </button>
      ))}
    </div>
  );
}
