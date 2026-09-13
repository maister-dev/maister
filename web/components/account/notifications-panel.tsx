"use client";

import type { ReactElement } from "react";

import {
  ArrowPathIcon,
  BellAlertIcon,
  BellSlashIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";

/**
 * Per-user push opt-in (ADR-173 D9/D11, `NTF-07`).
 *
 * Everything it needs about the DEPLOYMENT arrives as props: the public VAPID key
 * and whether push is configured at all. It never reads an env var, and the
 * private key has no path to a client component.
 *
 * The browser is the source of truth for "is push on HERE" — `localStorage` would
 * lie after a permission revocation — so the state is read from
 * `pushManager.getSubscription()` on mount.
 */

export interface NotificationsPanelLabels {
  title: string;
  sub: string;
  unavailable: string;
  unsupported: string;
  denied: string;
  enable: string;
  enabling: string;
  disable: string;
  enabled: string;
  disabled: string;
  failed: string;
  triggersTitle: string;
  triggerDecisions: string;
  triggerDigest: string;
  triggersNote: string;
  otherBrowsers: string;
}

export interface NotificationsPanelProps {
  /** `null` when the deployment has no VAPID configuration (`NTF-10`). */
  publicKey: string | null;
  /** Endpoints this reader has registered, including on other machines. */
  registeredEndpoints: number;
  labels: NotificationsPanelLabels;
}

type State =
  | "loading"
  | "unsupported"
  | "denied"
  | "off"
  | "on"
  | "busy"
  | "failed";

/** The VAPID public key crosses the wire base64url and must reach `subscribe` as bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/gu, "+").replace(/_/gu, "/");
  const raw = window.atob(normalized);
  const bytes = new Uint8Array(raw.length);

  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);

  return bytes;
}

export function NotificationsPanel({
  publicKey,
  registeredEndpoints,
  labels,
}: NotificationsPanelProps): ReactElement {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    if (publicKey === null) return;
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window)
    ) {
      setState("unsupported");

      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");

      return;
    }

    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? "on" : "off"))
      .catch(() => setState("off"));
  }, [publicKey]);

  async function enable(): Promise<void> {
    if (publicKey === null) return;
    setState("busy");
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");

      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");

        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const json = subscription.toJSON() as {
        endpoint?: string;
        expirationTime?: number | null;
        keys?: { p256dh?: string; auth?: string };
      };
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          expirationTime: json.expirationTime ?? null,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        }),
      });

      setState(response.ok ? "on" : "failed");
    } catch {
      setState("failed");
    }
  }

  async function disable(): Promise<void> {
    setState("busy");
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();

      if (subscription) {
        // The browser first, then the server: an endpoint the browser has
        // already dropped can never receive anything, so a failed server call
        // leaves a row the next `410 Gone` cleans up rather than a live
        // subscription the reader believes is off.
        await subscription.unsubscribe();
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => undefined);
      }
      setState("off");
    } catch {
      setState("failed");
    }
  }

  const message =
    publicKey === null
      ? labels.unavailable
      : state === "unsupported"
        ? labels.unsupported
        : state === "denied"
          ? labels.denied
          : state === "failed"
            ? labels.failed
            : state === "on"
              ? labels.enabled
              : state === "off"
                ? labels.disabled
                : null;

  return (
    <section
      className="rounded-[14px] border border-line bg-paper p-6 shadow-[var(--shadow-sm)]"
      data-testid="notifications-panel"
    >
      <h2 className="m-0 text-[17px] font-semibold tracking-[-0.015em] text-ink">
        {labels.title}
      </h2>
      <p className="mt-1 max-w-[62ch] text-[12.5px] leading-[1.5] text-mute">
        {labels.sub}
      </p>

      {message ? (
        <p
          className="mt-4 text-[12.5px] text-ink-2"
          data-testid="notifications-state"
          role="status"
        >
          {message}
        </p>
      ) : null}

      {publicKey !== null && state !== "unsupported" && state !== "denied" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {state === "on" ? (
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-danger/40 bg-ivory px-4 text-[12.5px] font-semibold text-danger disabled:opacity-60"
              data-testid="notifications-disable"
              disabled={state !== "on"}
              type="button"
              onClick={() => void disable()}
            >
              {/* Turning notifications off is the destructive half of this
                  pair, so it carries the muted-bell icon and the danger tone
                  rather than reading as the same weight as opting in. */}
              <BellSlashIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {labels.disable}
            </button>
          ) : (
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-amber px-4 text-[12.5px] font-semibold text-white disabled:opacity-60"
              data-testid="notifications-enable"
              disabled={state === "busy" || state === "loading"}
              type="button"
              onClick={() => void enable()}
            >
              {state === "busy" ? (
                <ArrowPathIcon
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <BellAlertIcon aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {state === "busy" ? labels.enabling : labels.enable}
            </button>
          )}
          {registeredEndpoints > 1 ? (
            <span className="font-mono text-[11px] text-mute">
              {labels.otherBrowsers.replace(
                "$count",
                String(registeredEndpoints - 1),
              )}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 border-t border-line pt-4">
        <h3 className="m-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute">
          {labels.triggersTitle}
        </h3>
        <ul className="mt-2.5 flex list-none flex-col gap-1.5 p-0 text-[12.5px] text-ink-2">
          <li>{labels.triggerDecisions}</li>
          <li>{labels.triggerDigest}</li>
        </ul>
        <p className="mt-2.5 m-0 text-[12px] text-mute">
          {labels.triggersNote}
        </p>
      </div>
    </section>
  );
}
