"use client";

import type { ReviewSelector } from "@/lib/queries/knowledge-memory-reviews";
import type { Dispatch, ReactElement, ReactNode, SetStateAction } from "react";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type AttentionReviewWatch = {
  selection: ReviewSelector | null;
  select: Dispatch<SetStateAction<ReviewSelector | null>>;
  invalidation: number;
  invalidate: () => void;
};

const ReviewWatch = createContext<AttentionReviewWatch | null>(null);

export function AttentionReviewProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [selection, select] = useState<ReviewSelector | null>(null);
  const [invalidation, setInvalidation] = useState(0);
  const invalidate = useCallback(() => {
    setInvalidation((revision) => revision + 1);
  }, []);

  return (
    <ReviewWatch.Provider
      value={{ selection, select, invalidation, invalidate }}
    >
      {children}
    </ReviewWatch.Provider>
  );
}

export function useAttentionReviewWatch(): AttentionReviewWatch | null {
  return useContext(ReviewWatch);
}

export function useWatchedReview({ kind, id }: ReviewSelector): number {
  const watch = useAttentionReviewWatch();
  const select = watch?.select;

  useEffect(() => {
    if (!select) return;
    const selection = { kind, id };

    select(selection);

    return () => select((active) => (active === selection ? null : active));
  }, [select, kind, id]);

  return watch?.invalidation ?? 0;
}
