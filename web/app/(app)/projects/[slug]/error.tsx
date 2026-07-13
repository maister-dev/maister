"use client";

import { ErrorFallback } from "@/components/feedback/error-fallback";

export default function ProjectError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return <ErrorFallback error={error} reset={reset} />;
}
