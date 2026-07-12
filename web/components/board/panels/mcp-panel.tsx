"use client";

import type { MatchCandidate } from "@/components/board/panels/mcp-bind-dialogs";
import type { ReactElement } from "react";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  ProjectMcpModal,
  type ProjectMcpRow,
} from "@/components/board/panels/mcp-modal";
import {
  MatchDialog,
  OverlayDialog,
} from "@/components/board/panels/mcp-bind-dialogs";

export type { ProjectMcpRow };

// ADR-129 (W-D): a derived requirement + its satisfaction classification.
export type McpRequirement = {
  refId: string;
  required: boolean;
  declaredBy: string[];
  classification: "bound" | "auto" | "unbound" | "misconfigured" | "not_ready";
};

// ADR-129 (T6.1 hub read model): one server visible in the project, across all
// three sources.
export type HubServerView = {
  refId: string;
  source: "platform" | "project" | "package";
  transport: string;
  enabled: boolean;
  trust?: string;
  readiness?: string;
  usedByCount?: number;
  boundByRefs: string[];
  lastProbeStatus?: string | null;
};

// ADR-129 (W-B): the current binding for a ref (write-side DTO echoed back).
export type McpBindingView = {
  refId: string;
  targetKind: "platform" | "project" | "package";
  targetId: string;
  enabled: boolean;
  configOverlay: {
    envRemap?: Record<string, string>;
    headerRemap?: Record<string, string>;
    argsOverride?: string[];
    urlOverride?: string;
  };
  recommendedHint: string | null;
};

// A platform server the project MAY connect (id === refId in this model).
export type PlatformCandidateView = {
  id: string;
  transport: string;
  trustStatus: string;
  enabled: boolean;
  envKeys: string[];
  headerKeys: string[];
};

export interface McpPanelProps {
  slug: string;
  isAdmin: boolean;
  requirements?: McpRequirement[];
  servers?: HubServerView[];
  bindings?: McpBindingView[];
  platformCandidates?: PlatformCandidateView[];
  projectServers?: ProjectMcpRow[];
}

function classBadgeClass(c: McpRequirement["classification"]): string {
  if (c === "bound" || c === "auto")
    return "border-emerald-500/30 text-emerald-700";
  if (c === "not_ready") return "border-amber/40 text-amber-2";

  return "border-red-500/30 text-red-700";
}

const actionBtn =
  "h-7 rounded-[8px] border border-line px-2.5 text-[11px] font-semibold text-ink-2 hover:border-amber hover:text-ink disabled:opacity-50";

export function McpPanel({
  slug,
  isAdmin,
  requirements = [],
  servers = [],
  bindings = [],
  platformCandidates = [],
  projectServers = [],
}: McpPanelProps): ReactElement {
  const t = useTranslations("mcpPanel");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectMcpRow | null>(null);
  const [matchRef, setMatchRef] = useState<string | null>(null);
  const [overlayBinding, setOverlayBinding] = useState<McpBindingView | null>(
    null,
  );
  const [connectId, setConnectId] = useState("");
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ADR-129 (T6.2): last Test-connection result per ref, surfaced inline so the
  // probe is not a silent no-op (the ledger has no probe column, and the probe
  // caches `last_probe_status` — not the `readiness_status` the table shows).
  const [probeResults, setProbeResults] = useState<
    Record<string, { ok: boolean; detail: string }>
  >({});

  const bindingByRef = new Map(bindings.map((b) => [b.refId, b]));
  const projectServerById = new Map(projectServers.map((s) => [s.id, s]));
  const projectServerByRef = new Map(projectServers.map((s) => [s.mcpId, s]));
  const platformById = new Map(platformCandidates.map((c) => [c.id, c]));

  const refresh = (): void => startTransition(() => router.refresh());

  // Bind candidates for a ref = the platform server whose id IS the ref (id ===
  // refId in this model) + every project MCP declaring that ref. Package MCPs are
  // configured via the overlay form, not matched here.
  const candidatesFor = (refId: string): MatchCandidate[] => {
    const platform = platformById.get(refId);
    const list: MatchCandidate[] = [];

    if (platform && platform.enabled) {
      list.push({
        targetKind: "platform",
        targetId: platform.id,
        transport: platform.transport,
        trust: platform.trustStatus,
      });
    }
    for (const server of projectServers) {
      if (server.mcpId === refId) {
        list.push({
          targetKind: "project",
          targetId: server.id,
          transport: server.transport,
        });
      }
    }

    return list;
  };

  const slotsFor = (
    binding: McpBindingView,
  ): { env: string[]; header: string[] } | undefined => {
    if (binding.targetKind === "platform") {
      const p = platformById.get(binding.targetId);

      return p ? { env: p.envKeys, header: p.headerKeys } : undefined;
    }
    if (binding.targetKind === "project") {
      const s = projectServerById.get(binding.targetId);

      return s ? { env: s.envKeys, header: s.headerKeys } : undefined;
    }

    return undefined; // package: free-form slots (server validates)
  };

  const act = (key: string, fn: () => Promise<Response>): void => {
    setBusyRef(key);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fn();

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            code?: string;
            message?: string;
          } | null;

          setError(
            `${t("actionFailed")}: ${payload?.message ?? payload?.code ?? res.status}`,
          );

          return;
        }
        router.refresh();
      } catch (err) {
        setError(
          `${t("actionFailed")}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setBusyRef(null);
      }
    });
  };

  const disconnect = (refId: string): void =>
    act(`disconnect:${refId}`, () =>
      fetch(`/api/projects/${encodeURIComponent(slug)}/mcp/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refId }),
      }),
    );

  const connect = (platformServerId: string): void =>
    act(`connect:${platformServerId}`, () =>
      fetch(`/api/projects/${encodeURIComponent(slug)}/mcp/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platformServerId }),
      }),
    );

  // Probe drives the supervisor handshake AND surfaces its result: a 200 may
  // still carry `{ok:false, reason}` (handshake failed), and a non-200 is a
  // trust-gate/precondition refusal — both are shown inline, never swallowed.
  const testConnection = (refId: string): void => {
    setBusyRef(`probe:${refId}`);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(slug)}/mcp/probe`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refId }),
          },
        );
        const payload = (await res.json().catch(() => null)) as {
          ok?: boolean;
          latencyMs?: number;
          reason?: string;
          code?: string;
          message?: string;
        } | null;

        setProbeResults((prev) => ({
          ...prev,
          [refId]:
            res.ok && payload?.ok
              ? {
                  ok: true,
                  detail:
                    payload.latencyMs != null ? `${payload.latencyMs}ms` : "",
                }
              : {
                  ok: false,
                  detail:
                    payload?.reason ??
                    payload?.message ??
                    payload?.code ??
                    String(res.status),
                },
        }));
      } catch (err) {
        setProbeResults((prev) => ({
          ...prev,
          [refId]: {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        setBusyRef(null);
      }
    });
  };

  const sourceLabel = (source: HubServerView["source"]): string =>
    source === "platform"
      ? t("sourcePlatform")
      : source === "project"
        ? t("sourceProject")
        : t("sourcePackage");

  // Platform servers offered in the connect picker: enabled and not ALREADY
  // connected — i.e. neither projected as a platform-source row nor carrying an
  // enabled platform binding. A same-ref server from ANOTHER source must not
  // hide it — platform + project implementations of one ref coexist by design.
  const connectable = platformCandidates.filter((c) => {
    if (!c.enabled) return false;
    const binding = bindingByRef.get(c.id);

    return (
      !servers.some((s) => s.source === "platform" && s.refId === c.id) &&
      !(binding?.enabled && binding.targetKind === "platform")
    );
  });

  const busy = pending || busyRef !== null;

  return (
    <section>
      {error ? (
        <div
          aria-live="assertive"
          className="mb-4 rounded-lg border border-amber-line bg-amber-soft px-3 py-2 font-mono text-[11px] font-semibold text-amber"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {requirements.length > 0 ? (
        <div className="mb-6" data-testid="mcp-requirements">
          <h3 className="m-0 mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-mute">
            {t("requirements")}
          </h3>
          <ul className="m-0 flex flex-col gap-1.5 p-0">
            {requirements.map((req) => {
              const binding = bindingByRef.get(req.refId);
              const enabledBinding = binding?.enabled ? binding : undefined;
              const canProbe =
                req.classification === "bound" ||
                req.classification === "auto" ||
                req.classification === "not_ready";

              return (
                <li
                  key={req.refId}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper px-3 py-2"
                  data-testid={`mcp-req-${req.refId}`}
                >
                  <span className="font-mono text-[12px] font-semibold text-ink">
                    {req.refId}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${classBadgeClass(
                      req.classification,
                    )}`}
                    data-testid={`mcp-req-class-${req.refId}`}
                  >
                    {t(`classification.${req.classification}`)}
                  </span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-mute">
                    {req.required ? t("requiredTag") : t("optionalTag")}
                  </span>
                  {req.declaredBy.length > 0 ? (
                    <span
                      className="font-mono text-[10px] text-mute"
                      title={req.declaredBy.join(", ")}
                    >
                      {t("declaredBy", { sources: req.declaredBy.join(", ") })}
                    </span>
                  ) : null}
                  {isAdmin ? (
                    <span className="ml-auto flex flex-wrap items-center gap-2">
                      <button
                        className={actionBtn}
                        disabled={busy}
                        type="button"
                        onClick={() => setMatchRef(req.refId)}
                      >
                        {enabledBinding ? t("rebind") : t("bind")}
                      </button>
                      {enabledBinding ? (
                        <button
                          className={actionBtn}
                          disabled={busy}
                          type="button"
                          onClick={() => setOverlayBinding(enabledBinding)}
                        >
                          {t("configure")}
                        </button>
                      ) : null}
                      {canProbe ? (
                        <button
                          className={actionBtn}
                          disabled={busy}
                          type="button"
                          onClick={() => testConnection(req.refId)}
                        >
                          {t("testConnection")}
                        </button>
                      ) : null}
                      {enabledBinding || req.classification === "auto" ? (
                        <button
                          className={actionBtn}
                          disabled={busy}
                          type="button"
                          onClick={() => disconnect(req.refId)}
                        >
                          {t("disconnect")}
                        </button>
                      ) : null}
                      {busyRef === `probe:${req.refId}` ? (
                        <span className="font-mono text-[10.5px] text-mute">
                          {t("probing")}
                        </span>
                      ) : probeResults[req.refId] ? (
                        <span
                          className={`font-mono text-[10.5px] ${
                            probeResults[req.refId].ok
                              ? "text-emerald-700"
                              : "text-amber-2"
                          }`}
                          data-testid={`mcp-probe-result-${req.refId}`}
                        >
                          {probeResults[req.refId].ok ? "✓" : "✗"}{" "}
                          {probeResults[req.refId].detail}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="m-0 font-sans text-base font-bold tracking-[-0.01em] text-ink">
          {t("title")}
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10.5px] tracking-[0.02em] text-mute">
            {t("count", { count: servers.length })}
          </span>
          {isAdmin ? (
            <button
              className="rounded-lg border border-amber bg-amber px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2"
              type="button"
              onClick={() => setCreating(true)}
            >
              {t("add")}
            </button>
          ) : null}
        </div>
      </div>

      {isAdmin && connectable.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            aria-label={t("connect")}
            className="h-8 rounded-[8px] border border-line bg-paper px-2 text-[12px] text-ink outline-none"
            data-testid="mcp-connect-select"
            disabled={busy}
            value={connectId}
            onChange={(e) => setConnectId(e.target.value)}
          >
            <option value="">{t("connect")}…</option>
            {connectable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} ({c.transport})
              </option>
            ))}
          </select>
          <button
            className={actionBtn}
            disabled={busy || connectId === ""}
            type="button"
            onClick={() => {
              if (connectId) connect(connectId);
              setConnectId("");
            }}
          >
            {t("connect")}
          </button>
        </div>
      ) : null}

      {!isAdmin ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {t("adminOnly")}
        </p>
      ) : servers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute">
          {t("empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-paper">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-mute">
                <th className="px-4 py-3">{t("colId")}</th>
                <th className="px-4 py-3">{t("colSource")}</th>
                <th className="px-4 py-3">{t("colTransport")}</th>
                <th className="px-4 py-3">{t("colTrust")}</th>
                <th className="px-4 py-3">{t("colReadiness")}</th>
                <th className="px-4 py-3">{t("colUsedBy")}</th>
                <th className="px-4 py-3">{t("colEnabled")}</th>
                <th className="px-4 py-3 text-right">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => {
                const local =
                  server.source === "project"
                    ? projectServerByRef.get(server.refId)
                    : undefined;

                return (
                  <tr
                    key={`${server.source}:${server.refId}`}
                    className="border-b border-line-soft align-middle text-[12px] last:border-b-0"
                    data-testid={`mcp-server-${server.refId}`}
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-ink">
                      {server.refId}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {sourceLabel(server.source)}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{server.transport}</td>
                    <td className="px-4 py-3 text-ink-2">
                      {server.trust ? (
                        <span
                          className={
                            server.trust === "trusted" ||
                            server.trust === "trusted_by_policy"
                              ? "text-emerald-700"
                              : "text-amber-2"
                          }
                        >
                          {server.trust === "trusted" ||
                          server.trust === "trusted_by_policy"
                            ? t("trustTrusted")
                            : t("needsTrust")}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {server.readiness ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {server.usedByCount !== undefined
                        ? t("usedByCount", { count: server.usedByCount })
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      {server.enabled ? "✓" : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        {local ? (
                          <button
                            className={actionBtn}
                            disabled={busy}
                            type="button"
                            onClick={() => setEditing(local)}
                          >
                            {t("edit")}
                          </button>
                        ) : null}
                        {server.source === "platform" ? (
                          <button
                            className={actionBtn}
                            disabled={busy}
                            type="button"
                            onClick={() => disconnect(server.refId)}
                          >
                            {t("disconnect")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating || editing ? (
        <ProjectMcpModal
          mode={editing ? "edit" : "create"}
          server={editing ?? undefined}
          slug={slug}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
      {matchRef ? (
        <MatchDialog
          candidates={candidatesFor(matchRef)}
          recommendedTargetId={
            // Only pre-select the platform target when it is bindable (enabled)
            // — mirrors candidatesFor; else fall through to the binding's hint.
            (platformById.get(matchRef)?.enabled
              ? platformById.get(matchRef)?.id
              : undefined) ??
            bindingByRef.get(matchRef)?.recommendedHint ??
            undefined
          }
          refId={matchRef}
          slug={slug}
          onClose={() => setMatchRef(null)}
          onDone={refresh}
        />
      ) : null}
      {overlayBinding ? (
        <OverlayDialog
          binding={overlayBinding}
          slots={slotsFor(overlayBinding)}
          slug={slug}
          onClose={() => setOverlayBinding(null)}
          onDone={refresh}
        />
      ) : null}
    </section>
  );
}
