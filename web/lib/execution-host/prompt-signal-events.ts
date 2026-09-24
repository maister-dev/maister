/** Event types a live flow consumer reacts to while a prompt turn runs — a
 * halting guardrail trip, a permission request, or the session ending. A turn
 * whose span carries any of them for its own session settles only through the
 * canonical projector, so the runner observes those signals exactly as before.
 * The flow consumer's handled types are pinned against this list by test.
 */
export const CONSUMER_SIGNAL_EVENT_TYPES = [
  "session.hook_trip",
  "session.permission_request",
  "session.exited",
  "session.crashed",
] as const;

export type ConsumerSignalEventType =
  (typeof CONSUMER_SIGNAL_EVENT_TYPES)[number];
