"use client";

import type { ThemeProviderProps } from "@/lib/theme";

import * as React from "react";

import { ThemeProvider } from "@/lib/theme";

export interface ProvidersProps {
  children: React.ReactNode;
  themeProps?: Omit<ThemeProviderProps, "children">;
}

export function Providers({ children, themeProps }: ProvidersProps) {
  return <ThemeProvider {...themeProps}>{children}</ThemeProvider>;
}
