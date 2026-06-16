"use client";

import type { ReactElement } from "react";

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
  if (theme === "light") {
    return (
      <svg
        aria-hidden="true"
        data-testid="theme-icon-light"
        fill="none"
        height="13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        viewBox="0 0 16 16"
        width="13"
      >
        <circle cx="8" cy="8" r="2.7" />
        <path d="M8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.24 3.76l-1.06 1.06M4.82 11.18l-1.06 1.06M12.24 12.24l-1.06-1.06M4.82 4.82L3.76 3.76" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      data-testid="theme-icon-dark"
      fill="currentColor"
      height="13"
      viewBox="0 0 16 16"
      width="13"
    >
      <path d="M6.2 1.6A6.4 6.4 0 1 0 14.4 9.8 5 5 0 0 1 6.2 1.6z" />
    </svg>
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
