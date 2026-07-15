"use client";

import * as React from "react";

import { FeedbackProvider } from "@/components/feedback/feedback-provider";
import { ThemeProvider } from "@/lib/theme";

export interface ProvidersProps {
  children: React.ReactNode;
  initialTheme: "light" | "dark";
}

export function Providers({ children, initialTheme }: ProvidersProps) {
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <FeedbackProvider>{children}</FeedbackProvider>
    </ThemeProvider>
  );
}
