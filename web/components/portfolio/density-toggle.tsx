"use client";

import type { ReactElement } from "react";

import { useState } from "react";

import { Tabs, type TabItem } from "@/components/navigation/tabs";

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

function DensityIcon({ density }: { density: Density }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
    >
      {icons[density]}
    </svg>
  );
}

export function DensityToggle({
  comfyLabel,
  compactLabel,
  listLabel,
}: DensityToggleProps): ReactElement {
  const [active, setActive] = useState<Density>("comfy");

  const items: TabItem[] = [
    { id: "comfy", label: comfyLabel },
    { id: "compact", label: compactLabel },
    { id: "list", label: listLabel },
  ].map(({ id, label }) => ({
    key: id,
    label,
    icon: <DensityIcon density={id as Density} />,
  }));

  return (
    <Tabs
      activeKey={active}
      ariaLabel="Density"
      items={items}
      onSelect={(key) => {
        setActive(key as Density);
        setDensity(key as Density);
      }}
    />
  );
}
