"use client";

import type { ReactElement, ReactNode } from "react";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

type Theme = "light" | "dark";
type ThemeChoice = Theme | "system";

export type ThemeProviderProps = {
  children: ReactNode;
  initialTheme: Theme;
};

type ThemeContextValue = {
  resolvedTheme: Theme;
  setTheme: (theme: ThemeChoice) => void;
  theme: ThemeChoice;
};

export const THEME_STORAGE_KEY = "theme";
const THEME_CLASS_NAMES = ["light", "dark"] as const;
const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;

  root.classList.remove(...THEME_CLASS_NAMES);
  root.classList.add(theme);

  root.style.colorScheme = theme;
}

export function ThemeProvider({
  children,
  initialTheme,
}: ThemeProviderProps): ReactElement {
  const [theme, setThemeState] = useState<ThemeChoice>(() => initialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() => initialTheme);

  useLayoutEffect(() => {
    applyTheme(resolvedTheme);
  }, []);

  useEffect(() => {
    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      const resolved = systemTheme();

      setResolvedTheme(resolved);
      applyTheme(resolved);
    };

    media.addEventListener("change", onChange);

    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback(async (nextTheme: ThemeChoice) => {
    const resolved = nextTheme === "system" ? systemTheme() : nextTheme;

    setThemeState(nextTheme);
    setResolvedTheme(resolved);
    applyTheme(resolved);

    try {
      window.cookieStore.set({
        sameSite: "strict",
        name: THEME_STORAGE_KEY,
        value: nextTheme,
      });
    } catch {
      return;
    }
  }, []);

  const value = useMemo(
    () => ({ resolvedTheme, setTheme, theme }),
    [resolvedTheme, setTheme, theme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (!value) {
    return {
      resolvedTheme: "dark",
      setTheme: () => {},
      theme: "dark",
    };
  }

  return value;
}
