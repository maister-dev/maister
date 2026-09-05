"use client";

import type { CreateFlowInput } from "@/lib/local-packages/create-flow-contract";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readCreateFlowApiError } from "@/lib/local-packages/create-flow-api-error";

// Shared "create a fresh local package" flow for the two studio list surfaces
// (`/studio/packages` central list + `/studio/local` management list). Both POST
// the same route and open the editor on success — only the surrounding form
// chrome (placement + testids + error display) differs per surface, so it stays
// in each component. This hook owns the drift-prone behavior (endpoint, error
// translation, navigation) so the two surfaces cannot diverge.
export function useNewLocalPackage(): {
  creating: boolean;
  setCreating: (value: boolean) => void;
  busy: boolean;
  error: string | null;
  setError: (value: string | null) => void;
  create: (input: { name: string; flow: CreateFlowInput }) => Promise<void>;
} {
  const tApiErrors = useTranslations("apiErrors");
  const tCreateFlow = useTranslations("studio.local.createFlow");
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(input: {
    name: string;
    flow: CreateFlowInput;
  }): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/studio/local-packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        setError(await readCreateFlowApiError(res, tApiErrors, tCreateFlow));

        return;
      }

      const created = (await res.json()) as {
        localPackage: { id: string };
        createdFlow: { path: string };
      };
      const encodedPath = created.createdFlow.path
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      router.push(`/studio/edit/${created.localPackage.id}/${encodedPath}`);
    } catch {
      setError(tApiErrors("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  return {
    creating,
    setCreating,
    busy,
    error,
    setError,
    create,
  };
}
