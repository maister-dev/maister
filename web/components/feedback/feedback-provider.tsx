"use client";

import type { ReactNode } from "react";

import { ToastProvider, toast } from "@heroui/react";
import { createContext, useCallback, useContext, useMemo, useRef } from "react";

import { appendFeedbackEvent, type FeedbackEvent } from "@/lib/feedback-state";

interface FeedbackMessage {
  message: string;
  mutationId: string;
}

interface FeedbackContextValue {
  error: (event: FeedbackMessage) => void;
  success: (event: FeedbackMessage) => void;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

function greenCheck(): ReactNode {
  return <span aria-hidden="true">✓</span>;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const eventsRef = useRef<readonly FeedbackEvent[]>([]);

  const emit = useCallback((event: FeedbackEvent): boolean => {
    const nextEvents = appendFeedbackEvent(eventsRef.current, event);
    const isNew = nextEvents.length > eventsRef.current.length;

    eventsRef.current = nextEvents;

    return isNew;
  }, []);

  const value = useMemo<FeedbackContextValue>(
    () => ({
      success: (event) => {
        if (emit({ ...event, kind: "success" })) {
          toast.success(event.message, { indicator: greenCheck() });
        }
      },
      error: (event) => {
        if (emit({ ...event, kind: "error" })) {
          toast.danger(event.message);
        }
      },
    }),
    [emit],
  );

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <ToastProvider maxVisibleToasts={3} placement="bottom end" />
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackContextValue {
  const feedback = useContext(FeedbackContext);

  if (!feedback) {
    throw new Error("useFeedback must be used within FeedbackProvider");
  }

  return feedback;
}
