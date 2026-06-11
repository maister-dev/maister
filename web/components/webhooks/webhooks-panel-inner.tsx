"use client";

import type { PingOutcome } from "@/components/webhooks/deliveries-drawer";
import type {
  SubscriptionModalValue,
  WebhookMethod,
} from "@/components/webhooks/subscription-modal";
import type {
  DeliveryDto,
  WebhookSubscriptionDto,
} from "@/lib/webhooks/subscriptions";
import type { ReactElement } from "react";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { DeliveriesDrawer } from "@/components/webhooks/deliveries-drawer";
import { SubscriptionModal } from "@/components/webhooks/subscription-modal";
import { SubscriptionsTable } from "@/components/webhooks/subscriptions-table";

export interface WebhooksPanelInnerProps {
  // Scope API base WITHOUT a trailing slash, e.g. `/api/admin/webhooks` or
  // `/api/projects/<slug>/webhooks`. Every CRUD/ping/deliveries/replay call is
  // derived from this — that single value is what makes the panel scope-agnostic.
  apiBase: string;
  canWrite: boolean;
  // Present ONLY for the platform scope. When set, the global kill-switch is
  // rendered and wired to GET/PATCH `{enabled}` on this endpoint. The project
  // scope passes it undefined → no switch.
  settingsApiBase?: string;
}

interface ParsedError {
  code?: string;
  message?: string;
}

async function parseError(res: Response): Promise<ParsedError> {
  const payload = (await res.json().catch(() => null)) as ParsedError | null;

  return {
    code: payload?.code,
    message: payload?.message ?? payload?.code,
  };
}

// Map the DTO row → the modal's edit value. A secret VALUE is never present on
// the DTO (only the env:NAME reference), so the modal can only ever see refs.
function toModalValue(sub: WebhookSubscriptionDto): SubscriptionModalValue {
  return {
    name: sub.name,
    url: sub.url,
    method: sub.method as WebhookMethod,
    headers: sub.headers,
    event_types: sub.event_types,
    signing_secret_ref: sub.signing_secret_ref,
    secondary_signing_secret_ref: sub.secondary_signing_secret_ref,
    enabled: sub.enabled,
  };
}

export function WebhooksPanelInner({
  apiBase,
  canWrite,
  settingsApiBase,
}: WebhooksPanelInnerProps): ReactElement {
  const t = useTranslations("webhooks");

  const [subscriptions, setSubscriptions] = useState<WebhookSubscriptionDto[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);

  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<WebhookSubscriptionDto | null>(null);

  const [deliveriesFor, setDeliveriesFor] =
    useState<WebhookSubscriptionDto | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryDto[]>([]);
  const [pingResult, setPingResult] = useState<PingOutcome | null>(null);

  const [globalEnabled, setGlobalEnabled] = useState<boolean | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(apiBase, { cache: "no-store" });

      if (!res.ok) {
        setError(t("loadError"));

        return;
      }

      const body = (await res.json()) as {
        subscriptions: WebhookSubscriptionDto[];
      };

      setSubscriptions(body.subscriptions);
      setError(null);
    } catch {
      setError(t("loadError"));
    }
  }, [apiBase, t]);

  const loadSettings = useCallback(async (): Promise<void> => {
    if (!settingsApiBase) return;

    try {
      const res = await fetch(settingsApiBase, { cache: "no-store" });

      if (!res.ok) return;

      const body = (await res.json()) as { enabled: boolean };

      setGlobalEnabled(body.enabled);
    } catch {
      // Kill-switch read is best-effort; the table still renders without it.
    }
  }, [settingsApiBase]);

  useEffect(() => {
    void refresh();
    void loadSettings();
  }, [refresh, loadSettings]);

  async function submit(value: SubscriptionModalValue): Promise<void> {
    const isCreate = modalMode === "create";
    const url = isCreate ? apiBase : `${apiBase}/${editing?.id ?? ""}`;
    const res = await fetch(url, {
      method: isCreate ? "POST" : "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });

    if (!res.ok) {
      const parsed = await parseError(res);

      setError(parsed.message ?? t("actionFailed"));

      return;
    }

    setModalMode(null);
    setEditing(null);
    setError(null);
    await refresh();
  }

  async function ping(sub: WebhookSubscriptionDto): Promise<void> {
    setDeliveriesFor(sub);
    setPingResult(null);
    await loadDeliveries(sub);

    const res = await fetch(`${apiBase}/${sub.id}/ping`, { method: "POST" });

    if (!res.ok) {
      setPingResult({ ok: false });

      return;
    }

    const body = (await res.json()) as { ok: boolean; httpStatus?: number };

    setPingResult({ ok: body.ok, httpStatus: body.httpStatus });
  }

  async function toggleEnabled(sub: WebhookSubscriptionDto): Promise<void> {
    const res = await fetch(`${apiBase}/${sub.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !sub.enabled }),
    });

    if (!res.ok) {
      const parsed = await parseError(res);

      setError(parsed.message ?? t("actionFailed"));

      return;
    }

    setError(null);
    await refresh();
  }

  async function loadDeliveries(sub: WebhookSubscriptionDto): Promise<void> {
    try {
      const res = await fetch(`${apiBase}/${sub.id}/deliveries`, {
        cache: "no-store",
      });

      if (!res.ok) {
        setDeliveries([]);

        return;
      }

      const body = (await res.json()) as { deliveries: DeliveryDto[] };

      setDeliveries(body.deliveries);
    } catch {
      setDeliveries([]);
    }
  }

  function showDeliveries(sub: WebhookSubscriptionDto): void {
    setDeliveriesFor(sub);
    setPingResult(null);
    void loadDeliveries(sub);
  }

  async function replay(deliveryId: string): Promise<void> {
    if (!deliveriesFor) return;

    const res = await fetch(
      `${apiBase}/${deliveriesFor.id}/deliveries/${deliveryId}/replay`,
      { method: "POST" },
    );

    if (!res.ok) {
      const parsed = await parseError(res);

      setError(parsed.message ?? t("actionFailed"));

      return;
    }

    await loadDeliveries(deliveriesFor);
  }

  async function toggleGlobal(): Promise<void> {
    if (!settingsApiBase || globalEnabled === null) return;

    const next = !globalEnabled;
    const res = await fetch(settingsApiBase, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });

    if (!res.ok) {
      setError(t("actionFailed"));

      return;
    }

    setGlobalEnabled(next);
    setError(null);
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("sectionTitle")}
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {t("count", { count: subscriptions.length })}
          </span>
          {canWrite ? (
            <button
              className="rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
              type="button"
              onClick={() => {
                setEditing(null);
                setModalMode("create");
              }}
            >
              {t("add")}
            </button>
          ) : null}
        </div>
      </div>

      {settingsApiBase && globalEnabled !== null ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-paper px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
              {t("globalToggleLabel")}
            </span>
            <span className="text-[11.5px] leading-[1.4] text-mute">
              {t("globalToggleHint")}
            </span>
          </div>
          <button
            aria-pressed={globalEnabled}
            className="h-8 rounded-[8px] border border-line px-3 font-mono text-[12px] font-semibold text-ink hover:border-mute"
            type="button"
            onClick={() => void toggleGlobal()}
          >
            {globalEnabled ? t("globalOn") : t("globalOff")}
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          aria-live="assertive"
          className="mb-4 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <SubscriptionsTable
        canWrite={canWrite}
        subscriptions={subscriptions}
        onEdit={(sub) => {
          setEditing(sub);
          setModalMode("edit");
        }}
        onPing={(sub) => void ping(sub)}
        onShowDeliveries={showDeliveries}
        onToggleEnabled={(sub) => void toggleEnabled(sub)}
      />

      {modalMode ? (
        <SubscriptionModal
          open
          initial={editing ? toModalValue(editing) : undefined}
          mode={modalMode}
          onClose={() => {
            setModalMode(null);
            setEditing(null);
          }}
          onSubmit={(value) => void submit(value)}
        />
      ) : null}

      {deliveriesFor ? (
        <DeliveriesDrawer
          canWrite={canWrite}
          deliveries={deliveries}
          pingResult={pingResult}
          onClose={() => {
            setDeliveriesFor(null);
            setDeliveries([]);
            setPingResult(null);
          }}
          onReplay={(deliveryId) => void replay(deliveryId)}
        />
      ) : null}
    </section>
  );
}
