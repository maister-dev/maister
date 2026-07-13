"use client";

import { ErrorFallback } from "@/components/feedback/error-fallback";

export default function RunError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return <ErrorFallback error={error} reset={reset} />;
}
