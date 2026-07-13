export type FeedbackKind = "success" | "error";

export interface FeedbackEvent {
  mutationId: string;
  kind: FeedbackKind;
  message: string;
}

export function appendFeedbackEvent(
  events: readonly FeedbackEvent[],
  event: FeedbackEvent,
): FeedbackEvent[] {
  if (events.some(({ mutationId }) => mutationId === event.mutationId)) {
    return [...events];
  }

  return [...events, event];
}
