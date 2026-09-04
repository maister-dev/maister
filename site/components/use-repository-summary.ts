"use client";

import { useCallback, useEffect, useState } from "react";

import type { RepositorySummary } from "@/lib/github-schema";

import { repositorySummarySchema } from "@/lib/github-schema";

export type RepositorySummaryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: RepositorySummary };

type UseRepositorySummary = {
  retry: () => void;
  state: RepositorySummaryState;
};

async function requestRepositorySummary(): Promise<RepositorySummary> {
  const response = await fetch("/api/github", { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`GitHub widget request failed with status ${response.status}`);
  }

  const parsed = repositorySummarySchema.safeParse(await response.json());

  if (!parsed.success) {
    throw new Error(`GitHub widget response was invalid: ${parsed.error.message}`);
  }

  return parsed.data;
}

export function useRepositorySummary(): UseRepositorySummary {
  const [state, setState] = useState<RepositorySummaryState>({ status: "loading" });

  const loadRepository = useCallback((): void => {
    setState({ status: "loading" });
    void requestRepositorySummary().then(
      (data) => setState({ data, status: "ready" }),
      (error: unknown) => {
        console.warn("GitHub repository widget request failed", { error });
        setState({ status: "error" });
      },
    );
  }, []);

  useEffect(() => {
    let isActive = true;

    void requestRepositorySummary().then(
      (data) => {
        if (isActive) setState({ data, status: "ready" });
      },
      (error: unknown) => {
        console.warn("GitHub repository widget request failed", { error });
        if (isActive) setState({ status: "error" });
      },
    );

    return () => {
      isActive = false;
    };
  }, []);

  return { retry: loadRepository, state };
}
