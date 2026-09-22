import type { ReactElement, ReactNode } from "react";
import type { AdminExecutionHostStatus } from "@/lib/execution-host/admin-status";

import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import { formatProjectionRearmCommand } from "@/lib/execution-host/admin-status";

function time(value: string | null, missing: string, locale: string): string {
  return value
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(value))
    : missing;
}

function duration(value: number | null, missing: string): string {
  if (value === null) return missing;
  if (value < 1_000) return `${value}ms`;

  const seconds = Math.floor(value / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;

  return [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    remainder > 0 || (hours === 0 && minutes === 0) ? `${remainder}s` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "good" | "warn" | "danger" | "neutral";
}): ReactElement {
  return (
    <span
      className={clsx(
        "inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold",
        tone === "good" && "border-good/30 bg-good/10 text-good",
        tone === "warn" && "border-amber-line bg-amber-soft text-amber",
        tone === "danger" && "border-danger/30 bg-danger/10 text-danger",
        tone === "neutral" && "border-line bg-ivory text-mute",
      )}
    >
      {children}
    </span>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="overflow-hidden rounded-[14px] border border-line bg-paper shadow-[var(--shadow-sm)]">
      <header className="border-b border-line px-5 py-4">
        <h2 className="m-0 text-[17px] font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-[12.5px] leading-[1.5] text-mute">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}

export async function ExecutionHostStatus({
  status,
}: {
  status: AdminExecutionHostStatus;
}): Promise<ReactElement> {
  const [t, locale] = await Promise.all([
    getTranslations("adminExecutionHost"),
    getLocale(),
  ]);
  const formatTime = (value: string | null, missing: string): string =>
    time(value, missing, locale);
  const observation = status.latestSweep?.observation;

  return (
    <div className="flex flex-col gap-5">
      <Panel subtitle={t("hosts.subtitle")} title={t("hosts.title")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="text-mute">
              <tr>
                <th className="px-5 py-3">{t("fields.host")}</th>
                <th className="px-3 py-3">{t("fields.readiness")}</th>
                <th className="px-3 py-3">{t("fields.reason")}</th>
                <th className="px-3 py-3">{t("fields.boot")}</th>
                <th className="px-3 py-3">{t("fields.version")}</th>
                <th className="px-5 py-3">{t("fields.lastSeen")}</th>
              </tr>
            </thead>
            <tbody>
              {status.hosts.map((host) => (
                <tr key={host.id} className="border-t border-line align-top">
                  <td className="px-5 py-3">
                    <div className="font-semibold text-ink">
                      {host.displayName}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-mute">
                      {host.hostKey} · {host.id}
                    </div>
                    <details className="mt-2 max-w-[320px] text-[11px] text-mute">
                      <summary className="cursor-pointer font-sans font-semibold">
                        {t("fields.capabilities")}
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded-md bg-ivory p-2">
                        {JSON.stringify(host.capabilities, null, 2)}
                      </pre>
                    </details>
                  </td>
                  <td className="px-3 py-3">
                    <Badge tone={host.readiness === "ready" ? "good" : "warn"}>
                      {host.readiness}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">{host.readinessReason ?? "—"}</td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {host.bootId ?? "—"}
                  </td>
                  <td className="px-3 py-3">{host.version ?? "—"}</td>
                  <td className="px-5 py-3">
                    {formatTime(host.lastSeenAt, t("missing"))}
                  </td>
                </tr>
              ))}
              {status.hosts.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-mute" colSpan={6}>
                    {t("hosts.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel subtitle={t("streams.subtitle")} title={t("streams.title")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="text-mute">
              <tr>
                <th className="px-5 py-3">{t("fields.stream")}</th>
                <th className="px-3 py-3">{t("fields.state")}</th>
                <th className="px-3 py-3">
                  {t("fields.watermarks")}
                  <div className="mt-1 text-[10px] font-normal normal-case">
                    {t("streams.watermarkLegend")}
                  </div>
                </th>
                <th className="px-3 py-3">{t("fields.hostHead")}</th>
                <th className="px-3 py-3">
                  {t("fields.lag")}
                  <div className="mt-1 text-[10px] font-normal normal-case">
                    {t("streams.lagLegend")}
                  </div>
                </th>
                <th className="px-3 py-3">{t("fields.pressure")}</th>
                <th className="px-3 py-3">{t("fields.claim")}</th>
                <th className="px-5 py-3">{t("fields.error")}</th>
              </tr>
            </thead>
            <tbody>
              {status.lag.streams.map((stream) => (
                <tr
                  key={stream.streamRowId}
                  className="border-t border-line align-top"
                >
                  <td className="px-5 py-3 font-mono text-xs">
                    {stream.streamId}
                    <div className="mt-1 text-mute">{stream.hostKey}</div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge
                      tone={
                        stream.streamState === "active"
                          ? "good"
                          : stream.streamState === "lost"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {stream.streamState}
                    </Badge>
                    <div className="mt-2 text-xs text-mute">
                      {t("streams.observation")}:{" "}
                      {observation?.stream?.verdict ?? t("missing")}
                    </div>
                    <div className="mt-1 text-[11px] text-mute">
                      {observation
                        ? t("streams.observationMeta", {
                            observer: observation.observerId,
                            sampledAt: formatTime(
                              observation.sampledAt,
                              t("missing"),
                            ),
                          })
                        : t("missing")}
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs leading-5">
                    R {stream.lastReceivedSequence ?? "—"}
                    <br />C {stream.lastContiguousSequence ?? "—"}
                    <br />A {stream.lastAckConfirmedSequence ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {stream.hostTelemetry?.headSequence ?? t("missing")}
                    <div className="mt-1 text-mute">
                      {t("streams.unacked")}:{" "}
                      {stream.hostTelemetry?.unacknowledgedCount ?? "—"}
                    </div>
                    <div className="text-mute">
                      {duration(
                        stream.hostTelemetry?.oldestUnacknowledgedAgeMs ?? null,
                        t("missing"),
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs leading-5">
                    H→M {stream.lag.hostToManager ?? "?"}
                    <br />G {stream.lag.contiguityGap ?? "?"}
                    <br />A {stream.lag.ackConfirmation ?? "?"}
                    <div className="mt-1 text-mute">
                      {stream.hostTelemetryStatus}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {stream.hostTelemetry?.pressured === undefined
                      ? "—"
                      : stream.hostTelemetry.pressured
                        ? t("yes")
                        : t("no")}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {stream.claimOwner ?? "—"}
                    <div className="mt-1 text-mute">
                      {formatTime(stream.claimExpiresAt, t("missing"))}
                    </div>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs">
                    {stream.lastError ? JSON.stringify(stream.lastError) : "—"}
                  </td>
                </tr>
              ))}
              {status.lag.streams.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-mute" colSpan={8}>
                    {t("streams.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel subtitle={t("consumers.subtitle")} title={t("consumers.title")}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="text-mute">
              <tr>
                <th className="px-5 py-3">{t("fields.run")}</th>
                <th className="px-3 py-3">{t("fields.consumer")}</th>
                <th className="px-3 py-3">{t("fields.backlog")}</th>
                <th className="px-3 py-3">{t("fields.cursor")}</th>
                <th className="px-3 py-3">{t("fields.served")}</th>
                <th className="px-5 py-3">{t("fields.nodeError")}</th>
              </tr>
            </thead>
            <tbody>
              {status.lag.consumers.top.map((consumer) => (
                <tr
                  key={`${consumer.runId}:${consumer.consumerName}`}
                  className="border-t border-line"
                >
                  <td className="px-5 py-3">
                    <Link
                      className="text-ink underline"
                      href={`/runs/${consumer.runId}`}
                    >
                      {consumer.runId}
                    </Link>
                    <div className="mt-1 text-xs text-mute">
                      {consumer.runStatus} ·{" "}
                      {consumer.executionHostId ?? t("consumers.unattributed")}
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {consumer.consumerName} · {consumer.state}
                  </td>
                  <td className="px-3 py-3 font-mono font-semibold">
                    {consumer.backlog ?? "—"}
                    {consumer.diagnostic ? (
                      <div className="mt-1 text-[10px] text-danger">
                        {t(`consumers.diagnostics.${consumer.diagnostic}`)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {consumer.lastRunSequence ?? "null"} /{" "}
                    {consumer.runHorizonSequence ?? "null"}
                  </td>
                  <td className="px-3 py-3">
                    {duration(consumer.serviceAgeMs, t("missing"))}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs">
                    {consumer.latestNodeErrorCode ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-mute">
          {t("consumers.count", {
            shown: status.lag.consumers.displayed,
            total: status.lag.consumers.totalConsumers,
            runs: status.lag.consumers.eligiblePopulation,
          })}
        </p>
        {status.lag.consumers.diagnosticCount > 0 ? (
          <div className="border-t border-danger/20 bg-danger/5 px-5 py-3 text-xs text-danger">
            {t("consumers.diagnosticCount", {
              count: status.lag.consumers.diagnosticCount,
            })}
            {status.lag.consumers.diagnostics.map((consumer) => (
              <div
                key={`diagnostic:${consumer.runId}:${consumer.consumerName}`}
                className="mt-1 font-mono"
              >
                {consumer.runId} · {consumer.consumerName} ·{" "}
                {t(`consumers.diagnostics.${consumer.diagnostic}`)}
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel subtitle={t("poison.subtitle")} title={t("poison.title")}>
        <div className="flex flex-col divide-y divide-line">
          {status.lag.poison.rows.map((row) => {
            const command = formatProjectionRearmCommand(row);

            return (
              <article
                key={`${row.runId}:${row.consumerName}`}
                className="px-5 py-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger">{row.consumerName}</Badge>
                  <Link
                    className="font-mono text-xs underline"
                    href={`/runs/${row.runId}`}
                  >
                    {row.runId}
                  </Link>
                  <span className="text-xs text-mute">{row.runStatus}</span>
                </div>
                <div className="mt-2 font-mono text-xs text-mute">
                  {row.lastErrorReason ?? t("missing")}
                </div>
                {command ? (
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-ivory p-3 text-[11px] text-ink">
                    {command}
                  </pre>
                ) : (
                  <p className="mt-2 text-xs text-danger">
                    {t("poison.incomplete")}
                  </p>
                )}
              </article>
            );
          })}
          {status.lag.poison.rows.length === 0 ? (
            <p className="px-5 py-6 text-sm text-mute">{t("poison.empty")}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-mute">
          <span>{t("poison.count", { total: status.lag.poison.total })}</span>
          {status.lag.poison.nextAfter ? (
            <Link
              className="font-semibold text-ink underline"
              href={{
                pathname: "/admin/execution-host",
                query: {
                  poisonRun: status.lag.poison.nextAfter.runId,
                  poisonConsumer: status.lag.poison.nextAfter.consumerName,
                },
              }}
            >
              {t("poison.next")}
            </Link>
          ) : null}
        </div>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel subtitle={t("workers.subtitle")} title={t("workers.title")}>
          <div className="border-b border-line px-5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
            {t("workers.current")}
          </div>
          <dl className="divide-y divide-line px-5">
            {Object.entries(status.workers).map(([name, worker]) => (
              <div
                key={name}
                className="flex items-center justify-between gap-3 py-3"
              >
                <dt className="font-mono text-xs text-ink">{name}</dt>
                <dd>
                  <Badge tone={worker.state === "running" ? "good" : "warn"}>
                    {worker.state}
                    {worker.reason ? ` · ${worker.reason}` : ""}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>
          <div className="border-y border-line px-5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
            {t("workers.latestSweep")}
            <span className="ml-2 normal-case tracking-normal">
              {observation
                ? t("workers.latestSweepMeta", {
                    observer: observation.observerId,
                    sampledAt: formatTime(observation.sampledAt, t("missing")),
                  })
                : t("missing")}
            </span>
          </div>
          <dl className="divide-y divide-line px-5">
            {Object.entries(observation?.workers.states ?? {}).map(
              ([name, worker]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <dt className="font-mono text-xs text-ink">{name}</dt>
                  <dd>
                    <Badge tone={worker.state === "running" ? "good" : "warn"}>
                      {worker.state}
                      {worker.reason ? ` · ${worker.reason}` : ""}
                    </Badge>
                  </dd>
                </div>
              ),
            )}
            {Object.keys(observation?.workers.states ?? {}).length === 0 ? (
              <div className="py-3 text-xs text-mute">{t("missing")}</div>
            ) : null}
          </dl>
        </Panel>

        <Panel subtitle={t("commands.subtitle")} title={t("commands.title")}>
          <dl className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
            <div>
              <dt className="text-mute">{t("fields.open")}</dt>
              <dd className="mt-1 text-xl font-semibold">
                {status.lag.commands.total}
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("fields.accepted")}</dt>
              <dd className="mt-1 text-xl font-semibold">
                {status.lag.commands.accepted}
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("fields.oldest")}</dt>
              <dd className="mt-1">
                {duration(
                  status.lag.commands.oldestAcceptedAgeMs,
                  t("missing"),
                )}
              </dd>
            </div>
            <div>
              <dt className="text-mute">{t("fields.impasse")}</dt>
              <dd className="mt-1 text-xl font-semibold">
                {observation?.commands.impasse ?? "—"}
              </dd>
            </div>
          </dl>
          <p className="border-t border-line px-5 py-3 text-xs text-mute">
            {observation
              ? t("commands.latestSweep", {
                  sampledAt: formatTime(observation.sampledAt, t("missing")),
                })
              : t("missing")}
          </p>
        </Panel>

        <Panel subtitle={t("clock.subtitle")} title={t("clock.title")}>
          <div className="px-5 py-4 text-sm">
            <Badge
              tone={
                status.schedulerClock.driver === "missing_tick"
                  ? "danger"
                  : "good"
              }
            >
              {status.schedulerClock.driver}
            </Badge>
            <p className="mt-3 text-mute">
              {t("clock.last", {
                value: formatTime(
                  status.schedulerClock.health.lastFinishedAt,
                  t("missing"),
                ),
              })}
            </p>
            <Link
              className="mt-3 inline-flex font-semibold text-ink underline"
              href="/admin/scheduler"
            >
              {t("clock.open")}
            </Link>
          </div>
        </Panel>
      </div>

      <p className="font-mono text-[10px] text-mute">
        {t("sampledAt", { value: formatTime(status.sampledAt, t("missing")) })}
      </p>
    </div>
  );
}
