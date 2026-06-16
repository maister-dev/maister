"use client";

import type { ReactElement } from "react";

import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import clsx from "clsx";

import { useTheme } from "@/lib/theme";

const navTool = clsx(
  "inline-flex items-center gap-1.5 rounded-lg border border-line",
  "px-2.5 py-[7px] font-mono text-[11px] leading-none tracking-[0.04em]",
  "text-mute transition-colors cursor-pointer",
  "hover:border-mute hover:text-ink",
);

export interface ThemeSwitchProps {
  className?: string;
}

export type ThemeMode = "dark" | "light";

export function ThemeModeIcon({ theme }: { theme: ThemeMode }): ReactElement {
  const Icon = theme === "light" ? SunIcon : MoonIcon;

  return (
    <Icon
      aria-hidden="true"
      className="h-[13px] w-[13px] shrink-0"
      data-testid={theme === "light" ? "theme-icon-light" : "theme-icon-dark"}
    />
  );
}

export function ThemeSwitch({ className }: ThemeSwitchProps): ReactElement {
  const [isMounted, setIsMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  const isLight = resolvedTheme === "light";

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return <div aria-hidden className="h-[29px] w-[68px]" />;
  }

  const handleToggle = () => {
    setTheme(isLight ? "dark" : "light");
  };

  return (
    <button
      aria-label={`Switch to ${isLight ? "dark" : "light"} mode`}
      aria-pressed={!isLight}
      className={clsx(
        navTool,
        "aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-paper",
        className,
      )}
      type="button"
      onClick={handleToggle}
    >
      <ThemeModeIcon theme={isLight ? "light" : "dark"} />
      <span>{isLight ? "Light" : "Dark"}</span>
    </button>
  );
}
