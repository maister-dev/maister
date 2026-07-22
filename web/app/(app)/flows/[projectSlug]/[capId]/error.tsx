"use client";

import { ErrorFallback } from "@/components/feedback/error-fallback";

// (ADR-149) Segment-level boundary for the authored-capability editor. A
// save/publish that loses the edit-lock throws `CONFLICT` from a server action;
// without this it unwinds to the ROOT boundary and tears down the whole app
// shell. Here it is contained to the editor segment with a reset affordance.
export default function AuthoredCapEditorError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return <ErrorFallback error={error} reset={reset} />;
}
