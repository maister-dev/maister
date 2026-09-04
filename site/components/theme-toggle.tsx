"use client";

import type { ReactElement } from "react";

import { useState, useSyncExternalStore } from "react";

type Theme = "light" | "dark";

type ThemeToggleProps = {
  darkLabel: string;
  darkText: string;
  lightLabel: string;
  lightText: string;
};

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribeToHydration(): () => void {
  return () => undefined;
}

function getClientSnapshot(): boolean {
  return true;
}

function getServerSnapshot(): boolean {
  return false;
}

function ThemeIcon({ theme }: { theme: Theme }): ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      {theme === "dark" ? (
        <path d="M13 8.5A5.5 5.5 0 1 1 7.5 3 4.5 4.5 0 0 0 13 8.5Z" fill="currentColor" />
      ) : (
        <path
          d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 2v1.5M8 12.5V14M14 8h-1.5M3.5 8H2M12.24 3.76l-1.06 1.06M4.82 11.18l-1.06 1.06M12.24 12.24l-1.06-1.06M4.82 4.82 3.76 3.76"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function ThemeToggle({
  darkLabel,
  darkText,
  lightLabel,
  lightText,
}: ThemeToggleProps): ReactElement {
  const [theme, setTheme] = useState<Theme | null>(null);
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientSnapshot,
    getServerSnapshot,
  );

  const toggleTheme = (): void => {
    const nextTheme: Theme = currentTheme() === "dark" ? "light" : "dark";

    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("maister-site-theme", nextTheme);
    setTheme(nextTheme);
  };

  const resolvedTheme = theme ?? (isHydrated ? currentTheme() : "light");
  const isDark = resolvedTheme === "dark";

  return (
    <button
      aria-label={isDark ? lightLabel : darkLabel}
      aria-pressed={isDark}
      className="icon-control"
      title={isDark ? lightLabel : darkLabel}
      type="button"
      onClick={toggleTheme}
    >
      <span className="icon-control-symbol">
        <ThemeIcon theme={resolvedTheme} />
      </span>
      <span className="icon-control-label">{isDark ? darkText : lightText}</span>
    </button>
  );
}
