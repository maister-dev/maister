// ADR-191 (LUI-04): what the owner was looking at when a message was sent.
// Captured at send, visibility-checked, never retargeted.
export type LibrarianSubject = {
  projectSlug?: string;
  taskIds?: string[];
  runId?: string;
};

export const LIBRARIAN_TURN_FAILURE_REASONS = [
  "start_failed",
  "host_lost",
  "deadline",
  "capability_trip",
  "summary_invalid",
] as const;
export type LibrarianTurnFailureReason =
  (typeof LIBRARIAN_TURN_FAILURE_REASONS)[number];
