"use client";

import type { ReactElement, ReactNode } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowPathIcon,
  PlayIcon,
  PowerIcon,
  StopIcon,
} from "@heroicons/react/24/outline";

import { PanelSection } from "@/components/settings/panel-section";

type Sidecar = {
  id: string;
  kind: "ccr";
  lifecycle: "managed" | "external";
  commandPreset: "ccr_start" | null;
  configPath: string | null;
  baseUrl: string | null;
  healthcheckUrl: string | null;
  authTokenRef: string | null;
  readinessStatus: "Unknown" | "Ready" | "NotReady";
  readinessReasons: string[];
  enabled: boolean;
};

type Props = {
  sidecars: Sidecar[];
  // ADR-093: live CCR process state per sidecar id (idle|starting|ready|failed|
  // stopping), seeded from supervisor diagnostics and updated on start/stop.
  processStateById?: Record<string, string>;
};

type CreateSidecarPayload = Omit<
  Sidecar,
  "enabled" | "readinessReasons" | "readinessStatus"
>;

async function requestJson(
  url: string,
  method: "PATCH" | "POST",
  body: unknown,
): Promise<{
  readinessStatus?: Sidecar["readinessStatus"];
  readinessReasons?: string[];
}> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }

  return (await response.json()) as {
    readinessStatus?: Sidecar["readinessStatus"];
    readinessReasons?: string[];
  };
}

async function lifecycleRequest(url: string): Promise<{ state: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;

    throw new Error(payload?.message ?? `request failed: ${response.status}`);
  }

  return (await response.json()) as { state: string };
}

function processTone(state: string | undefined): string {
  if (state === "ready") return "bg-good";
  if (state === "failed") return "bg-danger";
  if (state === "starting" || state === "stopping") return "bg-attention";

  return "bg-mute";
}

function IconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      aria-label={title}
      className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-line text-ink-2 hover:border-mute hover:text-ink disabled:opacity-50"
      disabled={disabled}
      title={title}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function RouterSidecarsPanel({
  sidecars,
  processStateById,
}: Props): ReactElement {
  const t = useTranslations("settings");
  const [items, setItems] = useState(sidecars);
  const [processState, setProcessState] = useState<Record<string, string>>(
    processStateById ?? {},
  );
  const [id, setId] = useState("");
  const [lifecycle, setLifecycle] = useState<Sidecar["lifecycle"]>("managed");
  const [configPath, setConfigPath] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [healthcheckUrl, setHealthcheckUrl] = useState("");
  const [authTokenRef, setAuthTokenRef] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createSidecar(): Promise<void> {
    setPending("create");
    setError(null);

    try {
      const payload: CreateSidecarPayload = {
        id,
        kind: "ccr",
        lifecycle,
        commandPreset: lifecycle === "managed" ? "ccr_start" : null,
        configPath: configPath || null,
        baseUrl: baseUrl || null,
        healthcheckUrl: healthcheckUrl || null,
        authTokenRef: authTokenRef || null,
      };

      const result = await requestJson(
        "/api/admin/router-sidecars",
        "POST",
        payload,
      );

      setItems((current) => [
        ...current,
        {
          ...payload,
          kind: "ccr",
          readinessStatus: result.readinessStatus ?? "Unknown",
          readinessReasons: result.readinessReasons ?? [],
          enabled: true,
        },
      ]);
      setId("");
      setConfigPath("");
      setBaseUrl("");
      setHealthcheckUrl("");
      setAuthTokenRef("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function setEnabled(
    sidecarId: string,
    enabled: boolean,
  ): Promise<void> {
    setPending(sidecarId);
    setError(null);

    try {
      const result = await requestJson(
        `/api/admin/router-sidecars/${sidecarId}`,
        "PATCH",
        {
          enabled,
        },
      );

      setItems((current) =>
        current.map((item) =>
          item.id === sidecarId
            ? {
                ...item,
                enabled,
                readinessStatus: result.readinessStatus ?? item.readinessStatus,
                readinessReasons:
                  result.readinessReasons ?? item.readinessReasons,
              }
            : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function refreshSidecar(sidecarId: string): Promise<void> {
    setPending(sidecarId);
    setError(null);

    try {
      const result = await requestJson(
        `/api/admin/router-sidecars/${sidecarId}`,
        "PATCH",
        {},
      );

      setItems((current) =>
        current.map((item) =>
          item.id === sidecarId
            ? {
                ...item,
                readinessStatus: result.readinessStatus ?? item.readinessStatus,
                readinessReasons:
                  result.readinessReasons ?? item.readinessReasons,
              }
            : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function changeLifecycle(
    sidecarId: string,
    action: "start" | "stop",
  ): Promise<void> {
    setPending(sidecarId);
    setError(null);

    try {
      const { state } = await lifecycleRequest(
        `/api/admin/router-sidecars/${sidecarId}/${action}`,
      );

      setProcessState((current) => ({ ...current, [sidecarId]: state }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <PanelSection title={t("routerSidecars")}>
      <div className="mb-3 grid gap-2 rounded-[8px] border border-line bg-canvas p-3">
        <div className="grid gap-2 md:grid-cols-2">
          <input
            className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
            placeholder={t("sidecarId")}
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
          <select
            className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
            value={lifecycle}
            onChange={(event) =>
              setLifecycle(event.target.value as Sidecar["lifecycle"])
            }
          >
            <option value="managed">managed</option>
            <option value="external">external</option>
          </select>
          <input
            className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
            placeholder={t("configPath")}
            value={configPath}
            onChange={(event) => setConfigPath(event.target.value)}
          />
          <input
            className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
            placeholder={t("baseUrl")}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <input
            className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
            placeholder={t("healthcheckUrl")}
            value={healthcheckUrl}
            onChange={(event) => setHealthcheckUrl(event.target.value)}
          />
          <input
            className="h-9 rounded-[8px] border border-line bg-paper px-2.5 text-[12px] text-ink outline-none"
            placeholder={t("authTokenRef")}
            value={authTokenRef}
            onChange={(event) => setAuthTokenRef(event.target.value)}
          />
        </div>
        <button
          className="h-9 rounded-[8px] border border-line bg-ink px-3 text-[12px] font-semibold text-paper disabled:opacity-50"
          disabled={pending !== null || !id}
          type="button"
          onClick={() => void createSidecar()}
        >
          {t("create")}
        </button>
        {error ? (
          <p className="m-0 text-[12px] leading-[1.45] text-red-700">{error}</p>
        ) : null}
      </div>
      <div className="grid gap-2">
        {items.map((sidecar) => {
          const state = processState[sidecar.id];
          const stateLabel = state ?? "unknown";
          const isRunning = state === "ready" || state === "starting";

          return (
            <article
              key={sidecar.id}
              className="rounded-[8px] border border-line bg-canvas px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-label={stateLabel}
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${processTone(
                      state,
                    )}`}
                    role="img"
                    title={stateLabel}
                  />
                  <div className="min-w-0">
                    <h3 className="m-0 truncate text-[14px] font-semibold text-ink">
                      {sidecar.id}
                    </h3>
                    <p className="m-0 mt-0.5 font-mono text-[11px] leading-[1.45] text-mute">
                      {sidecar.kind} / {sidecar.lifecycle} /{" "}
                      {sidecar.readinessStatus}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {isRunning ? (
                    <IconButton
                      disabled={pending !== null}
                      title={t("sidecarStop")}
                      onClick={() => void changeLifecycle(sidecar.id, "stop")}
                    >
                      <StopIcon className="h-4 w-4" />
                    </IconButton>
                  ) : (
                    <IconButton
                      disabled={pending !== null}
                      title={t("sidecarStart")}
                      onClick={() => void changeLifecycle(sidecar.id, "start")}
                    >
                      <PlayIcon className="h-4 w-4" />
                    </IconButton>
                  )}
                  <IconButton
                    disabled={pending !== null}
                    title={t("refresh")}
                    onClick={() => void refreshSidecar(sidecar.id)}
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    disabled={pending !== null}
                    title={sidecar.enabled ? t("disable") : t("enable")}
                    onClick={() =>
                      void setEnabled(sidecar.id, !sidecar.enabled)
                    }
                  >
                    <PowerIcon className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
              <dl className="m-0 mt-3 grid gap-1 font-mono text-[10.5px] leading-[1.45] text-mute">
                {sidecar.configPath ? (
                  <div className="min-w-0">
                    <dt className="inline text-ink">{t("configPath")}: </dt>
                    <dd className="m-0 inline break-all">
                      {sidecar.configPath}
                    </dd>
                  </div>
                ) : null}
                {sidecar.baseUrl ? (
                  <div className="min-w-0">
                    <dt className="inline text-ink">{t("baseUrl")}: </dt>
                    <dd className="m-0 inline break-all">{sidecar.baseUrl}</dd>
                  </div>
                ) : null}
                {sidecar.healthcheckUrl ? (
                  <div className="min-w-0">
                    <dt className="inline text-ink">{t("healthcheckUrl")}: </dt>
                    <dd className="m-0 inline break-all">
                      {sidecar.healthcheckUrl}
                    </dd>
                  </div>
                ) : null}
                {sidecar.authTokenRef ? (
                  <div className="min-w-0">
                    <dt className="inline text-ink">{t("authTokenRef")}: </dt>
                    <dd className="m-0 inline break-all">
                      {sidecar.authTokenRef}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {sidecar.readinessReasons.length > 0 ? (
                <ul className="m-0 mt-3 grid gap-1 p-0 text-[11.5px] leading-[1.45] text-mute">
                  {sidecar.readinessReasons.map((reason) => (
                    <li key={reason} className="list-none">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        })}
      </div>
    </PanelSection>
  );
}
