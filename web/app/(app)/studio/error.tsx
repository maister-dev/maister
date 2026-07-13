"use client";

import { ErrorFallback } from "@/components/feedback/error-fallback";

export default function StudioError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return <ErrorFallback error={error} reset={reset} />;
}
