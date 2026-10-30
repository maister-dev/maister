"use client";

import type {
  ConfigPersistReason,
  ConfigPreview,
  ConfigPushResult,
  ConfigPushReview,
  ConfigReceipt,
  ConfigStatus,
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
  error: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current;

    try {
      const observed = await request<ConfigStatus>(
        `/api/projects/${slug}/persist-config`,
        "GET",
      );

      if (generation.current === current) {
        setStatus(observed);
        setError(false);
      }
    } catch {
      if (generation.current === current) {
        setStatus(null);
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

  return { status, error, refresh };
}

export function useConfigPersistence(
  slug: string,
  refreshStatus: () => Promise<void>,
): ConfigPersistenceController {
  const t = useTranslations("projects.configPersistence");
  const router = useRouter();
  const base = `/api/projects/${slug}/persist-config`;
  const storageKey = `maister.config-operation.${slug}`;
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

  function acceptReceipt(value: ConfigReceipt): void {
    setReceipt(value);
    setPushResult(null);
    setPreview(null);
    if (
      ["committed", "noop", "stale", "failed"].includes(value.state) &&
      !["pending", "unknown"].includes(value.pushState)
    ) {
      window.sessionStorage.removeItem(storageKey);
      setUncertainId(null);
    }
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
      setReceipt(null);
      setUncertainId(null);
      setPushReview(null);
      setPushResult(null);
      setPreview(null);
      setPreview(await request<ConfigPreview>(`${base}/preview`, "POST", {}));
      await refreshStatus();
    });
  }

  async function show(): Promise<void> {
    if (locked.current) return;
    setOpen(true);
    const saved = window.sessionStorage.getItem(storageKey);

    if (saved) {
      setUncertainId(saved);
      await run(async () => {
        acceptReceipt(await request<ConfigReceipt>(`${base}/${saved}`, "GET"));
      });
    } else await freshPreview();
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
    const id = receipt?.operationId ?? uncertainId;

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
  show: () => Promise<void>;
  readReceipt: (id: string) => Promise<void>;
  freshPreview: () => Promise<void>;
  confirm: () => Promise<void>;
  recover: () => Promise<void>;
  reviewPush: () => Promise<void>;
  confirmPush: () => Promise<void>;
  close: () => void;
};
