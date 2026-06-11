"use client";

import type { ModelGroup } from "@/components/settings/model-autocomplete";
import type { PresetRow } from "@/components/settings/acp-runner-modal";
import type { RunnerDraft } from "@/lib/acp-runners/runner-form";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

const ENDPOINT = "/api/admin/acp-runners/model-suggestions";
const DEBOUNCE_MS = 400;

type SuggestionsResponse = {
  groups: ModelGroup[];
};

function providerBody(draft: RunnerDraft): Record<string, unknown> {
  switch (draft.providerKind) {
    case "anthropic_compatible":
      return {
        kind: "anthropic_compatible",
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.authToken ? { authToken: draft.authToken } : {}),
      };
    case "openai_compatible":
      return {
        kind: "openai_compatible",
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        ...(draft.wireApi ? { wireApi: "responses" } : {}),
      };
    case "openai":
      return { kind: "openai" };
    default:
      return { kind: "anthropic" };
  }
}

function requestBody(
  draft: RunnerDraft,
  force: boolean,
): Record<string, unknown> {
  const ccr = draft.sidecarId != null && draft.sidecarId.length > 0;

  return {
    adapter: draft.adapter,
    provider: providerBody(draft),
    ...(ccr ? { router: "ccr", sidecarId: draft.sidecarId } : {}),
    ...(force ? { force: true } : {}),
  };
}

function presetGroup(
  presets: PresetRow[],
  draft: RunnerDraft,
  label: string,
): ModelGroup | null {
  // Dedupe by model id — several presets share a model (e.g. two claude
  // presets both `claude-sonnet-4-6`), which would collide React keys.
  const seen = new Set<string>();
  const models = presets
    .filter((preset) => preset.adapter === draft.adapter)
    .map((preset) => ({ id: preset.model }))
    .filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);

      return true;
    });

  if (models.length === 0) return null;

  return { source: "preset", label, status: "ok", models };
}

function mergePresetGroup(
  fetched: ModelGroup[],
  preset: ModelGroup | null,
): ModelGroup[] {
  if (!preset) return fetched;

  const known = new Set(
    fetched.flatMap((group) => group.models.map((model) => model.id)),
  );
  const novel = preset.models.filter((model) => !known.has(model.id));

  if (novel.length === 0) return fetched;

  return [...fetched, { ...preset, models: novel }];
}

export function useModelSuggestions(
  draft: RunnerDraft,
  presets: PresetRow[],
): {
  groups: ModelGroup[];
  loading: boolean;
  error: boolean;
  refresh: () => void;
} {
  const t = useTranslations("settings");
  const presetLabel = t("modelSuggestions.sources.preset");

  const preset = presetGroup(presets, draft, presetLabel);
  const [fetched, setFetched] = useState<ModelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      const reqId = ++reqIdRef.current;

      abortRef.current?.abort();
      const controller = new AbortController();

      abortRef.current = controller;

      setLoading(true);
      setError(false);

      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (reqId !== reqIdRef.current) return;

        if (!res.ok) {
          setError(true);
          setFetched([]);

          return;
        }

        const payload = (await res.json()) as SuggestionsResponse;

        if (reqId !== reqIdRef.current) return;

        setFetched(Array.isArray(payload.groups) ? payload.groups : []);
      } catch {
        if (controller.signal.aborted || reqId !== reqIdRef.current) return;
        setError(true);
        setFetched([]);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    },
    [],
  );

  const refresh = useCallback((): void => {
    void run(requestBody(draft, true));
    // env-ref NAMES (authToken/apiKey) are part of the supervisor cache key
    // (ADR-076 §4) — changing them must re-resolve.
  }, [
    run,
    draft.adapter,
    draft.providerKind,
    draft.baseUrl,
    draft.authToken,
    draft.apiKey,
    draft.sidecarId,
  ]);

  useEffect(() => {
    const handle = setTimeout(() => {
      void run(requestBody(draft, false));
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
    // env-ref NAMES (authToken/apiKey) are part of the supervisor cache key
    // (ADR-076 §4) — changing them must re-resolve.
  }, [
    run,
    draft.adapter,
    draft.providerKind,
    draft.baseUrl,
    draft.authToken,
    draft.apiKey,
    draft.sidecarId,
  ]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    groups: mergePresetGroup(fetched, preset),
    loading,
    error,
    refresh,
  };
}
