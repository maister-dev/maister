"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

// Shared "create a fresh local package" flow for the two studio list surfaces
// (`/studio/packages` central list + `/studio/local` management list). Both POST
// the same route and open the editor on success — only the surrounding form
// chrome (placement + testids + error display) differs per surface, so it stays
// in each component. This hook owns the drift-prone behavior (endpoint, error
// translation, navigation) so the two surfaces cannot diverge.
export function useNewLocalPackage(): {
  creating: boolean;
  setCreating: (value: boolean) => void;
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  error: string | null;
  setError: (value: string | null) => void;
  create: () => Promise<void>;
} {
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    const trimmed = name.trim();

    if (trimmed === "") return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/studio/local-packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      const created = (await res.json()) as { id: string };

      router.push(`/studio/edit/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return {
    creating,
    setCreating,
    name,
    setName,
    busy,
    error,
    setError,
    create,
  };
}
