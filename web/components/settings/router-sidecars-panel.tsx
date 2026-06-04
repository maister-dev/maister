"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";

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

export function RouterSidecarsPanel({ sidecars }: Props): ReactElement {
  const t = useTranslations("settings");
  const [items, setItems] = useState(sidecars);
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

  return (
    <section className="mt-6 border-t border-line pt-6">
      <div className="mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-mute">
        {t("routerSidecars")}
      </div>
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
        {items.map((sidecar) => (
          <article
            key={sidecar.id}
            className="rounded-[8px] border border-line bg-canvas px-4 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="m-0 text-[14px] font-semibold text-ink">
                  {sidecar.id}
                </h3>
                <p className="m-0 mt-1 font-mono text-[11px] leading-[1.45] text-mute">
                  {sidecar.kind} / {sidecar.lifecycle} /{" "}
                  {sidecar.readinessStatus}
                </p>
              </div>
              <button
                className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                disabled={pending !== null}
                type="button"
                onClick={() => void refreshSidecar(sidecar.id)}
              >
                {t("refresh")}
              </button>
              <button
                className="h-8 rounded-[8px] border border-line px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                disabled={pending !== null}
                type="button"
                onClick={() => void setEnabled(sidecar.id, !sidecar.enabled)}
              >
                {sidecar.enabled ? t("disable") : t("enable")}
              </button>
            </div>
            <dl className="m-0 mt-3 grid gap-1 font-mono text-[10.5px] leading-[1.45] text-mute">
              {sidecar.configPath ? (
                <div className="min-w-0">
                  <dt className="inline text-ink">{t("configPath")}: </dt>
                  <dd className="m-0 inline break-all">{sidecar.configPath}</dd>
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
        ))}
      </div>
    </section>
  );
}
