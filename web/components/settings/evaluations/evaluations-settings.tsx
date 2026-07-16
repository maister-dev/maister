"use client";

import type { JudgePanelRow, MethodologyRow, ProfileRow } from "./types";
import type { ReactElement } from "react";

import {
  CheckCircleIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import clsx from "clsx";

import { JudgePanelModal } from "./judge-panel-modal";
import { ProfileModal } from "./profile-modal";

type Tab = "methodologies" | "panels" | "profiles";

type Props = {
  methodologies: MethodologyRow[];
  panels: JudgePanelRow[];
  profiles: ProfileRow[];
};

function HealthDot({
  health,
  labels,
  reasons,
}: {
  health: MethodologyRow["health"];
  labels: Record<MethodologyRow["health"], string>;
  reasons: string[] | null;
}): ReactElement {
  const tone =
    health === "ready"
      ? "bg-good"
      : health === "degraded"
        ? "bg-attention"
        : "bg-mute";
  const title =
    reasons && reasons.length > 0 ? reasons.join("; ") : labels[health];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-label={title}
        className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${tone}`}
        role="img"
        title={title}
      />
      <span className="text-[12px] text-ink-2">{labels[health]}</span>
    </span>
  );
}

export function EvaluationsSettings({
  methodologies,
  panels,
  profiles,
}: Props): ReactElement {
  const t = useTranslations("settingsEvaluations");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [tab, setTab] = useState<Tab>("methodologies");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelModal, setPanelModal] = useState<
    { mode: "create" } | { mode: "edit"; panel: JudgePanelRow } | null
  >(null);
  const [profileModal, setProfileModal] = useState<
    { mode: "create" } | { mode: "edit"; profile: ProfileRow } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = (): void => startTransition(() => router.refresh());
  const healthLabels: Record<MethodologyRow["health"], string> = {
    ready: t("healthReady"),
    degraded: t("healthDegraded"),
    incompatible: t("healthIncompatible"),
  };

  async function setActivation(
    row: MethodologyRow,
    activation: "enabled" | "disabled",
  ): Promise<void> {
    setPending(row.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/evaluations/methodologies/${row.id}/activation`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ activation }),
        },
      );

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;

        throw new Error(payload?.message ?? `request failed: ${res.status}`);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  async function remove(
    kind: "judge-panels" | "profiles",
    id: string,
    revision: number,
  ): Promise<void> {
    setPending(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/evaluations/${kind}/${id}`, {
        method: "DELETE",
        headers: { "if-match": String(revision) },
      });

      if (res.status === 204 || res.ok) {
        setConfirmDelete(null);
        refresh();

        return;
      }
      const payload = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;

      // 409 CONFLICT = usage-guarded (a profile still references this panel, or
      // an override references this profile). Surface the reason.
      setError(
        payload?.code === "CONFLICT"
          ? `${t("deleteBlocked")}: ${payload.message ?? ""}`
          : (payload?.message ?? `request failed: ${res.status}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  const tabs: { id: Tab; label: string; count: number }[] = [
    {
      id: "methodologies",
      label: t("tabMethodologies"),
      count: methodologies.length,
    },
    { id: "panels", label: t("tabPanels"), count: panels.length },
    { id: "profiles", label: t("tabProfiles"), count: profiles.length },
  ];

  return (
    <div className="w-full">
      <div className="mb-5 flex flex-wrap items-center gap-1 border-b border-line">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={clsx(
              "-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold",
              tab === entry.id
                ? "border-ink text-ink"
                : "border-transparent text-mute hover:text-ink-2",
            )}
            type="button"
            onClick={() => setTab(entry.id)}
          >
            {entry.label}{" "}
            <span className="font-mono text-[11px] text-mute">
              ({entry.count})
            </span>
          </button>
        ))}
      </div>

      {error ? (
        <p className="mb-3 text-[12px] text-red-700" role="alert">
          {error}
        </p>
      ) : null}

      {tab === "methodologies" ? (
        <div className="overflow-x-auto">
          {methodologies.length === 0 ? (
            <p className="text-[13px] text-mute">{t("noMethodologies")}</p>
          ) : (
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead className="border-b border-line bg-ivory">
                <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                  <th className="px-4 py-3">{t("colMethod")}</th>
                  <th className="px-4 py-3">{t("colPackage")}</th>
                  <th className="px-4 py-3">{t("colHealth")}</th>
                  <th className="px-4 py-3">{t("colActivation")}</th>
                  <th className="px-4 py-3 text-right">{t("colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {methodologies.map((m) => (
                  <tr
                    key={m.id}
                    className="border-b border-line align-middle text-[12px] last:border-b-0"
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-ink">
                      {m.qualifiedId}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {m.packageName} · {m.versionLabel}
                    </td>
                    <td className="px-4 py-3">
                      <HealthDot
                        health={m.health}
                        labels={healthLabels}
                        reasons={m.validationErrors}
                      />
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {m.activation === "enabled" ? "✓" : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-line px-2.5 text-[12px] font-semibold text-ink hover:border-mute disabled:opacity-50"
                        disabled={
                          pending !== null ||
                          (m.activation === "disabled" && m.health !== "ready")
                        }
                        title={
                          m.activation === "disabled" && m.health !== "ready"
                            ? t("enableBlockedHealth")
                            : undefined
                        }
                        type="button"
                        onClick={() =>
                          void setActivation(
                            m,
                            m.activation === "enabled" ? "disabled" : "enabled",
                          )
                        }
                      >
                        {m.activation === "enabled" ? (
                          <NoSymbolIcon
                            aria-hidden="true"
                            className="h-4 w-4"
                          />
                        ) : (
                          <CheckCircleIcon
                            aria-hidden="true"
                            className="h-4 w-4"
                          />
                        )}
                        {m.activation === "enabled"
                          ? t("disable")
                          : t("enable")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {tab === "panels" ? (
        <div>
          <div className="mb-3 flex justify-end">
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-ink px-3 text-[13px] font-semibold text-paper"
              type="button"
              onClick={() => setPanelModal({ mode: "create" })}
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t("addPanel")}
            </button>
          </div>
          <div className="overflow-x-auto">
            {panels.length === 0 ? (
              <p className="text-[13px] text-mute">{t("noPanels")}</p>
            ) : (
              <table className="w-full min-w-[680px] border-collapse text-left">
                <thead className="border-b border-line bg-ivory">
                  <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                    <th className="px-4 py-3">{t("colName")}</th>
                    <th className="px-4 py-3">{t("colRoles")}</th>
                    <th className="px-4 py-3">{t("colQuorum")}</th>
                    <th className="px-4 py-3">{t("colEnabled")}</th>
                    <th className="px-4 py-3 text-right">{t("colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {panels.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-line align-middle text-[12px] last:border-b-0"
                    >
                      <td className="px-4 py-3 font-semibold text-ink">
                        {p.name}
                      </td>
                      <td className="px-4 py-3 font-mono text-ink-2">
                        {p.roleBindings.map((r) => r.role).join(", ")}
                      </td>
                      <td className="px-4 py-3 font-mono text-ink-2">
                        {p.policy.quorum}/{p.policy.attempts}
                      </td>
                      <td className="px-4 py-3 text-ink-2">
                        {p.enabled ? "✓" : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            aria-label={t("edit")}
                            className="grid h-8 w-8 place-items-center rounded-[8px] border border-line text-ink hover:border-mute"
                            title={t("edit")}
                            type="button"
                            onClick={() =>
                              setPanelModal({ mode: "edit", panel: p })
                            }
                          >
                            <PencilSquareIcon
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                          </button>
                          {confirmDelete === p.id ? (
                            <button
                              className="h-8 rounded-[8px] border border-[#b5332b] bg-[#b5332b] px-2.5 text-[12px] font-semibold text-white disabled:opacity-50"
                              disabled={pending !== null}
                              type="button"
                              onClick={() =>
                                void remove("judge-panels", p.id, p.revision)
                              }
                            >
                              {t("confirm")}
                            </button>
                          ) : (
                            <button
                              aria-label={t("delete")}
                              className="grid h-8 w-8 place-items-center rounded-[8px] border border-[#b5332b]/40 text-[#b5332b] hover:bg-[#b5332b]/5"
                              title={t("delete")}
                              type="button"
                              onClick={() => setConfirmDelete(p.id)}
                            >
                              <TrashIcon
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}

      {tab === "profiles" ? (
        <div>
          <div className="mb-3 flex justify-end">
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-ink px-3 text-[13px] font-semibold text-paper disabled:opacity-50"
              disabled={panels.length === 0 || methodologies.length === 0}
              title={
                panels.length === 0 || methodologies.length === 0
                  ? t("profileNeedsDeps")
                  : undefined
              }
              type="button"
              onClick={() => setProfileModal({ mode: "create" })}
            >
              <PlusIcon aria-hidden="true" className="h-4 w-4" />
              {t("addProfile")}
            </button>
          </div>
          <div className="overflow-x-auto">
            {profiles.length === 0 ? (
              <p className="text-[13px] text-mute">{t("noProfiles")}</p>
            ) : (
              <table className="w-full min-w-[680px] border-collapse text-left">
                <thead className="border-b border-line bg-ivory">
                  <tr className="font-mono text-[10px] uppercase tracking-[0.12em] text-mute">
                    <th className="px-4 py-3">{t("colName")}</th>
                    <th className="px-4 py-3">{t("colMethod")}</th>
                    <th className="px-4 py-3">{t("colPanel")}</th>
                    <th className="px-4 py-3">{t("colEnabled")}</th>
                    <th className="px-4 py-3 text-right">{t("colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-line align-middle text-[12px] last:border-b-0"
                    >
                      <td className="px-4 py-3 font-semibold text-ink">
                        {p.name}
                      </td>
                      <td className="px-4 py-3 font-mono text-ink-2">
                        {methodologies.find((m) => m.id === p.methodRevisionId)
                          ?.qualifiedId ?? p.methodRevisionId}
                      </td>
                      <td className="px-4 py-3 text-ink-2">
                        {panels.find((pn) => pn.id === p.panelId)?.name ??
                          p.panelId}
                      </td>
                      <td className="px-4 py-3 text-ink-2">
                        {p.enabled ? "✓" : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            aria-label={t("edit")}
                            className="grid h-8 w-8 place-items-center rounded-[8px] border border-line text-ink hover:border-mute"
                            title={t("edit")}
                            type="button"
                            onClick={() =>
                              setProfileModal({ mode: "edit", profile: p })
                            }
                          >
                            <PencilSquareIcon
                              aria-hidden="true"
                              className="h-4 w-4"
                            />
                          </button>
                          {confirmDelete === p.id ? (
                            <button
                              className="h-8 rounded-[8px] border border-[#b5332b] bg-[#b5332b] px-2.5 text-[12px] font-semibold text-white disabled:opacity-50"
                              disabled={pending !== null}
                              type="button"
                              onClick={() =>
                                void remove("profiles", p.id, p.revision)
                              }
                            >
                              {t("confirm")}
                            </button>
                          ) : (
                            <button
                              aria-label={t("delete")}
                              className="grid h-8 w-8 place-items-center rounded-[8px] border border-[#b5332b]/40 text-[#b5332b] hover:bg-[#b5332b]/5"
                              title={t("delete")}
                              type="button"
                              onClick={() => setConfirmDelete(p.id)}
                            >
                              <TrashIcon
                                aria-hidden="true"
                                className="h-4 w-4"
                              />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}

      {panelModal ? (
        <JudgePanelModal
          mode={panelModal.mode}
          panel={panelModal.mode === "edit" ? panelModal.panel : undefined}
          onClose={() => setPanelModal(null)}
        />
      ) : null}
      {profileModal ? (
        <ProfileModal
          methodologies={methodologies}
          mode={profileModal.mode}
          panels={panels}
          profile={
            profileModal.mode === "edit" ? profileModal.profile : undefined
          }
          onClose={() => setProfileModal(null)}
        />
      ) : null}
    </div>
  );
}
