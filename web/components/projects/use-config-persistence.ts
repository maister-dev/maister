"use client";

import type {
  ConfigPersistReason,
  ConfigPreview,
  ConfigPushResult,
  ConfigPushReview,
  ConfigReceipt,
  ConfigStatus,
  ConfigWorkflow,
} from "@/lib/project-config-persistence/contracts";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { CONFIG_PERSIST_REASONS } from "@/lib/project-config-persistence/contracts";

class ConfigRequestError extends Error {
  constructor(readonly reason?: ConfigPersistReason) {
    super("Configuration request failed");
  }
}

async function request<T>(
  url: string,
  method: "GET" | "POST",
  body?: object,
): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

  if (!response.ok) {
    const payload = (await response.json()) as {
      details?: { reason?: string };
    };

    throw new ConfigRequestError(
      CONFIG_PERSIST_REASONS.find(
        (reason) => reason === payload.details?.reason,
      ),
    );
  }

  return (await response.json()) as T;
}

export function useConfigStatus(
  slug: string,
  exportRevision: string,
): {
  status: ConfigStatus | null;
  workflow: ConfigWorkflow | null;
  error: boolean;
  refresh: () => Promise<void>;
} {
  const [workflow, setWorkflow] = useState<ConfigWorkflow | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current;

    try {
      const observed = await request<ConfigWorkflow>(
        `/api/projects/${encodeURIComponent(slug)}/persist-config?view=workflow`,
        "GET",
      );

      if (generation.current === current) {
        setWorkflow(observed);
        setError(false);
      }
    } catch {
      if (generation.current === current) {
        setError(true);
      }
    }
  }, [slug]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    const focused = (): void => {
      void refresh();
    };

    window.addEventListener("focus", focused);

    return () => {
      generation.current++;
      window.removeEventListener("focus", focused);
    };
  }, [refresh, exportRevision]);

  return {
    status:
      workflow?.checkout.state === "observed" ? workflow.checkout.status : null,
    workflow,
    error,
    refresh,
  };
}

export function useConfigPersistence(
  slug: string,
  actorUserId: string,
  refreshStatus: () => Promise<void>,
): ConfigPersistenceController {
  const t = useTranslations("projects.configPersistence");
  const router = useRouter();
  const base = `/api/projects/${slug}/persist-config`;
  const storageKey = `maister.config-operation.${actorUserId}.${slug}`;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [receipt, setReceipt] = useState<ConfigReceipt | null>(null);
  const [pushReview, setPushReview] = useState<ConfigPushReview | null>(null);
  const [pushResult, setPushResult] = useState<ConfigPushResult | null>(null);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const locked = useRef(false);
  const invalidate = async (): Promise<void> => {
    await refreshStatus();
    router.refresh();
  };

  function recordReceipt(value: ConfigReceipt): void {
    if (receipt?.operationId !== value.operationId) setPushReview(null);
    setReceipt(value);
    setPushResult(null);
    if (
      ["committed", "noop", "stale", "failed"].includes(value.state) &&
      !["pending", "unknown"].includes(value.pushState)
    ) {
      window.sessionStorage.removeItem(storageKey);
      setUncertainId(null);
    }
  }

  function acceptReceipt(value: ConfigReceipt): void {
    recordReceipt(value);
    setPreview(null);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof ConfigRequestError && failure.reason
          ? t(`reasons.${failure.reason}`)
          : t("requestFailed"),
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function freshPreview(): Promise<void> {
    await run(async () => {
      setPreview(null);
      setPreview(await request<ConfigPreview>(`${base}/preview`, "POST", {}));
      await refreshStatus();
    });
  }

  async function refreshObservation(): Promise<void> {
    const id = uncertainId ?? receipt?.operationId;

    await run(async () => {
      try {
        if (id)
          recordReceipt(await request<ConfigReceipt>(`${base}/${id}`, "GET"));
      } finally {
        await refreshStatus();
      }
    });
  }

  async function show(operationId?: string): Promise<void> {
    if (locked.current) return;
    setOpen(true);
    const saved = window.sessionStorage.getItem(storageKey);

    if (saved) {
      setUncertainId(saved);
      await run(async () => {
        recordReceipt(await request<ConfigReceipt>(`${base}/${saved}`, "GET"));
      });
    } else if (operationId) await readReceipt(operationId);
    else if (receipt) await refreshObservation();
    else if (!pushReview) await freshPreview();
  }

  async function readReceipt(id: string): Promise<void> {
    setOpen(true);
    await run(async () => {
      acceptReceipt(await request<ConfigReceipt>(`${base}/${id}`, "GET"));
    });
  }

  async function confirm(): Promise<void> {
    if (preview?.kind !== "ready") return;
    const id = preview.previewId;

    await run(async () => {
      // Record identity before sending effects; reload always observes the same operation.
      window.sessionStorage.setItem(storageKey, id);
      setUncertainId(id);
      try {
        acceptReceipt(
          await request<ConfigReceipt>(base, "POST", { previewId: id }),
        );
      } catch (failure) {
        setPreview(null);
        // A lost response is observationally resolved; recovery remains an explicit action.
        try {
          acceptReceipt(await request<ConfigReceipt>(`${base}/${id}`, "GET"));
        } catch {
          /* Keep the durable locator visible for explicit retry. */
        }
        throw failure;
      } finally {
        await invalidate();
      }
    });
  }

  async function recover(): Promise<void> {
    const id = uncertainId ?? receipt?.operationId;

    if (!id) return;
    await run(async () => {
      acceptReceipt(
        await request<ConfigReceipt>(`${base}/${id}/recover`, "POST", {}),
      );
      await invalidate();
    });
  }

  async function reviewPush(): Promise<void> {
    if (receipt?.state !== "committed") return;
    const id = receipt.operationId;

    await run(async () => {
      setPushResult(null);
      setPushReview(
        await request<ConfigPushReview>(
          `${base}/${id}/push/preview`,
          "POST",
          {},
        ),
      );
    });
  }

  async function confirmPush(): Promise<void> {
    if (!pushReview || !receipt) return;
    const id = receipt.operationId;
    const reviewId = pushReview.pushPreviewId;

    await run(async () => {
      window.sessionStorage.setItem(storageKey, id);
      setUncertainId(id);
      try {
        setPushResult(
          await request<ConfigPushResult>(`${base}/${id}/push`, "POST", {
            pushPreviewId: reviewId,
          }),
        );
        setPushReview(null);
        acceptReceipt(await request<ConfigReceipt>(`${base}/${id}`, "GET"));
      } catch (failure) {
        setPushReview(null);
        try {
          acceptReceipt(await request<ConfigReceipt>(`${base}/${id}`, "GET"));
        } catch {
          /* Preserve the same operation for explicit recovery. */
        }
        throw failure;
      } finally {
        await invalidate();
      }
    });
  }

  function close(): void {
    if (!locked.current) setOpen(false);
  }

  return {
    open,
    busy,
    error,
    preview,
    receipt,
    pushReview,
    pushResult,
    uncertainId,
    show,
    readReceipt,
    refreshObservation,
    freshPreview,
    confirm,
    recover,
    reviewPush,
    confirmPush,
    close,
  };
}

export type ConfigPersistenceController = {
  open: boolean;
  busy: boolean;
  error: string | null;
  preview: ConfigPreview | null;
  receipt: ConfigReceipt | null;
  pushReview: ConfigPushReview | null;
  pushResult: ConfigPushResult | null;
  uncertainId: string | null;
  show: (operationId?: string) => Promise<void>;
  readReceipt: (id: string) => Promise<void>;
  refreshObservation: () => Promise<void>;
  freshPreview: () => Promise<void>;
  confirm: () => Promise<void>;
  recover: () => Promise<void>;
  reviewPush: () => Promise<void>;
  confirmPush: () => Promise<void>;
  close: () => void;
};
