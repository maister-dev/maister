"use client";

import type { ReactElement, ReactNode } from "react";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type Theme = "light" | "dark";
type ThemeChoice = Theme | "system";
type ThemeAttribute = "class" | `data-${string}`;

export type ThemeProviderProps = {
  children: ReactNode;
  attribute?: ThemeAttribute;
  defaultTheme?: ThemeChoice;
  enableSystem?: boolean;
  storageKey?: string;
};

type ThemeContextValue = {
  resolvedTheme: Theme;
  setTheme: (theme: ThemeChoice) => void;
  theme: ThemeChoice;
};

const DEFAULT_STORAGE_KEY = "theme";
const THEME_CLASS_NAMES = ["light", "dark"] as const;
const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): Theme {
  if (typeof window === "undefined") return "dark";

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function storedTheme(storageKey: string): ThemeChoice | null {
  if (typeof window === "undefined") return null;

  try {
    const stored = window.localStorage.getItem(storageKey);

    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    return null;
  }

  return null;
}

function resolveTheme(theme: ThemeChoice, enableSystem: boolean): Theme {
  if (theme === "system" && enableSystem) return systemTheme();
  if (theme === "system") return "dark";

  return theme;
}

function applyTheme(attribute: ThemeAttribute, theme: Theme): void {
  const root = document.documentElement;

  if (attribute === "class") {
    root.classList.remove(...THEME_CLASS_NAMES);
    root.classList.add(theme);
  } else {
    root.setAttribute(attribute, theme);
  }

  root.style.colorScheme = theme;
}

export function ThemeProvider({
  attribute = "class",
  children,
  defaultTheme = "dark",
  enableSystem = true,
  storageKey = DEFAULT_STORAGE_KEY,
}: ThemeProviderProps): ReactElement {
  const [theme, setThemeState] = useState<ThemeChoice>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() =>
    resolveTheme(defaultTheme, enableSystem),
  );

  useEffect(() => {
    const initialTheme = storedTheme(storageKey) ?? defaultTheme;
    const resolved = resolveTheme(initialTheme, enableSystem);

    setThemeState(initialTheme);
    setResolvedTheme(resolved);
    applyTheme(attribute, resolved);
  }, [attribute, defaultTheme, enableSystem, storageKey]);

  useEffect(() => {
    if (!enableSystem || theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      const resolved = systemTheme();

      setResolvedTheme(resolved);
      applyTheme(attribute, resolved);
    };

    media.addEventListener("change", onChange);

    return () => media.removeEventListener("change", onChange);
  }, [attribute, enableSystem, theme]);

  const setTheme = useCallback(
    (nextTheme: ThemeChoice): void => {
      const resolved = resolveTheme(nextTheme, enableSystem);

      setThemeState(nextTheme);
      setResolvedTheme(resolved);
      applyTheme(attribute, resolved);

      try {
        window.localStorage.setItem(storageKey, nextTheme);
      } catch {
        return;
      }
    },
    [attribute, enableSystem, storageKey],
  );

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
