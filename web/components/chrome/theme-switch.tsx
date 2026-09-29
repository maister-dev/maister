"use client";

import type { ReactElement } from "react";

import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import clsx from "clsx";

import { useTheme } from "@/lib/theme";

const navTool = clsx(
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line",
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
    // Reserves what the mounted button occupies at each breakpoint by laying
    // out the same box, invisibly — icon-only below `lg`, icon + word above.
    // "Light" is the wider word, so hydration can only narrow the header, never
    // push it past the viewport: a fixed 68px was Dark's width, and Light grew
    // the header 8px at mount.
    return (
      <div aria-hidden className={clsx(navTool, "invisible")}>
        <span className="h-[13px] w-[13px] shrink-0" />
        <span className="hidden lg:inline">Light</span>
      </div>
    );
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
      {/* The icon already says which mode is on, and `aria-label` says what the
          button does — so the word is the part narrow viewports can spare. */}
      <span className="hidden lg:inline">{isLight ? "Light" : "Dark"}</span>
    </button>
  );
}
