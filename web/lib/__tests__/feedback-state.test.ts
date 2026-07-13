import { describe, expect, it } from "vitest";

import { appendFeedbackEvent, type FeedbackEvent } from "@/lib/feedback-state";

describe("feedback event state", () => {
  it("keeps the first completed mutation event and de-duplicates retries", () => {
    const completed: FeedbackEvent = {
      mutationId: "package:install-1",
      kind: "success",
      message: "Installed",
    };

    const first = appendFeedbackEvent([], completed);
    const duplicate = appendFeedbackEvent(first, {
      ...completed,
      message: "Installed again",
    });

    expect(first).toEqual([completed]);
    expect(duplicate).toEqual([completed]);
    expect(duplicate).not.toBe(first);
  });

  it("retains distinct completed mutations in their completion order", () => {
    const events = appendFeedbackEvent(
      [
        {
          mutationId: "launch:run-1",
          kind: "success",
          message: "Launched",
        },
      ],
      {
        mutationId: "settings:project-1",
        kind: "error",
        message: "Could not save",
      },
    );

    expect(events.map((event) => event.mutationId)).toEqual([
      "launch:run-1",
      "settings:project-1",
    ]);
  });
});
