import type { ReactElement, ReactNode } from "react";
import type {
  AdminExecutionHostRow,
  AdminExecutionHostStatus,
} from "@/lib/execution-host/admin-status";
import type {
  ExecutionConsumerLag,
  ExecutionEventLagReadModel,
  ExecutionEventStreamLag,
  PoisonedExecutionConsumer,
} from "@/types/execution-host-observability";
import type { SchedulerClockStatus } from "@/types/scheduler";
import type { DurableWorkerState } from "@/lib/workers/health";
import type { ExecutionObservabilitySummary } from "@/lib/execution-host/events/lag-observation";

import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import clsx from "clsx";

import {
  formatDuration,
  formatInstant,
} from "@/components/admin/observability-format";
import {
  formatProjectionRearmCommand,
  isPanelUnavailable,
} from "@/lib/execution-host/admin-status";

type Tone = "good" | "warn" | "danger" | "neutral";
type Translate = Awaited<ReturnType<typeof getTranslations>>;

type Format = Readonly<{
  t: Translate;
  time: (value: string | null) => string;
  span: (value: number | null) => string;
  missing: string;
}>;

// The affordance rule: a status cell leads with a glyph, so the state is
// legible before the label is read and in a locale the reader does not speak.
const TONE_GLYPH: Record<Tone, string> = {
  good: "✓",
  warn: "▲",
  danger: "✗",
  neutral: "·",
};

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}): ReactElement {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold",
        tone === "good" && "border-good/30 bg-good/10 text-good",
        tone === "warn" && "border-amber-line bg-amber-soft text-amber",
        tone === "danger" && "border-danger/30 bg-danger/10 text-danger",
        tone === "neutral" && "border-line bg-ivory text-mute",
      )}
    >
      <span aria-hidden>{TONE_GLYPH[tone]}</span>
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

function PanelUnavailable({ t }: { t: Translate }): ReactElement {
  return (
    <p className="px-5 py-6 text-sm text-danger" role="status">
      <span aria-hidden>▲ </span>
      {t("panelUnavailable")}
    </p>
  );
}

function readinessTone(readiness: string): Tone {
  if (readiness === "ready") return "good";
  if (readiness === "unavailable") return "danger";

  return "warn";
}

function streamStateTone(state: ExecutionEventStreamLag["streamState"]): Tone {
  if (state === "active") return "good";
  if (state === "lost") return "danger";

  return "neutral";
}

function verdictTone(verdict: string): Tone {
  if (verdict === "clear") return "good";
  if (verdict === "lagging" || verdict === "not_advancing") return "danger";

  return "neutral";
}

function HostsPanel({
  hosts,
  format,
}: {
  hosts: AdminExecutionHostStatus["hosts"];
  format: Format;
}): ReactElement {
  const { t, time } = format;

  return (
    <Panel subtitle={t("hosts.subtitle")} title={t("hosts.title")}>
      {isPanelUnavailable(hosts) ? (
        <PanelUnavailable t={t} />
      ) : (
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
              {hosts.map((host: AdminExecutionHostRow) => (
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
                    <Badge tone={readinessTone(host.readiness)}>
                      {t(`readiness.${host.readiness}`)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3">{host.readinessReason ?? "—"}</td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {host.bootId ?? "—"}
                  </td>
                  <td className="px-3 py-3">{host.version ?? "—"}</td>
                  <td className="px-5 py-3">{time(host.lastSeenAt)}</td>
                </tr>
              ))}
              {hosts.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-mute" colSpan={6}>
                    {t("hosts.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function StreamsPanel({
  streams,
  observation,
  format,
}: {
  streams: readonly ExecutionEventStreamLag[];
  observation: ExecutionObservabilitySummary | null | undefined;
  format: Format;
}): ReactElement {
  const { t, time, span, missing } = format;

  return (
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
            {streams.map((stream) => (
              <tr
                key={stream.streamRowId}
                className="border-t border-line align-top"
              >
                <td className="px-5 py-3 font-mono text-xs">
                  {stream.streamId}
                  <div className="mt-1 text-mute">{stream.hostKey}</div>
                </td>
                <td className="px-3 py-3">
                  <Badge tone={streamStateTone(stream.streamState)}>
                    {t(`streamState.${stream.streamState}`)}
                  </Badge>
                  <div className="mt-2 text-xs text-mute">
                    {t("streams.observation")}:{" "}
                    {observation?.stream?.verdict ? (
                      <Badge tone={verdictTone(observation.stream.verdict)}>
                        {t(`verdict.${observation.stream.verdict}`)}
                      </Badge>
                    ) : (
                      missing
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-mute">
                    {observation
                      ? t("streams.observationMeta", {
                          observer: observation.observerId,
                          sampledAt: time(observation.sampledAt),
                        })
                      : missing}
                  </div>
                </td>
                <td className="px-3 py-3 font-mono text-xs leading-5">
                  R {stream.lastReceivedSequence ?? "—"}
                  <br />C {stream.lastContiguousSequence ?? "—"}
                  <br />A {stream.lastAckConfirmedSequence ?? "—"}
                </td>
                <td className="px-3 py-3 font-mono text-xs">
                  {stream.hostTelemetry?.headSequence ?? missing}
                  <div className="mt-1 text-mute">
                    {t("streams.unacked")}:{" "}
                    {stream.hostTelemetry?.unacknowledgedCount ?? "—"}
                  </div>
                  <div className="text-mute">
                    {span(
                      stream.hostTelemetry?.oldestUnacknowledgedAgeMs ?? null,
                    )}
                  </div>
                </td>
                <td className="px-3 py-3 font-mono text-xs leading-5">
                  H→M {stream.lag.hostToManager ?? "?"}
                  <br />G {stream.lag.contiguityGap ?? "?"}
                  <br />A {stream.lag.ackConfirmation ?? "?"}
                  <div className="mt-1 font-sans text-mute">
                    {t(`telemetryStatus.${stream.hostTelemetryStatus}`)}
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
                    {time(stream.claimExpiresAt)}
                  </div>
                </td>
                <td className="px-5 py-3 font-mono text-xs">
                  {stream.lastError ? JSON.stringify(stream.lastError) : "—"}
                </td>
              </tr>
            ))}
            {streams.length === 0 ? (
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
  );
}

function ConsumersPanel({
  consumers,
  format,
}: {
  consumers: ExecutionEventLagReadModel["consumers"];
  format: Format;
}): ReactElement {
  const { t, span } = format;

  return (
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
            {consumers.top.map((consumer: ExecutionConsumerLag) => (
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
                  {consumer.consumerName}
                  <div className="mt-1 font-sans">
                    <Badge tone={consumer.state === "ready" ? "good" : "warn"}>
                      {t(`consumerState.${consumer.state}`)}
                    </Badge>
                  </div>
                </td>
                <td className="px-3 py-3 font-mono font-semibold">
                  {consumer.backlog ?? "—"}
                  {consumer.diagnostic ? (
                    <div className="mt-1 font-sans text-[10px] text-danger">
                      <span aria-hidden>✗ </span>
                      {t(`consumers.diagnostics.${consumer.diagnostic}`)}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3 font-mono text-xs">
                  {consumer.lastRunSequence ?? "null"} /{" "}
                  {consumer.runHorizonSequence ?? "null"}
                </td>
                <td className="px-3 py-3">{span(consumer.serviceAgeMs)}</td>
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
          shown: consumers.displayed,
          total: consumers.totalConsumers,
          runs: consumers.eligiblePopulation,
        })}
      </p>
      {consumers.diagnosticCount > 0 ? (
        <div className="border-t border-danger/20 bg-danger/5 px-5 py-3 text-xs text-danger">
          {t("consumers.diagnosticCount", {
            count: consumers.diagnosticCount,
          })}
          {consumers.diagnostics.map((consumer: ExecutionConsumerLag) => (
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
  );
}

function PoisonPanel({
  poison,
  cursor,
  format,
}: {
  poison: ExecutionEventLagReadModel["poison"];
  cursor: { runId: string; consumerName: string } | undefined;
  format: Format;
}): ReactElement {
  const { t, missing } = format;

  return (
    <Panel subtitle={t("poison.subtitle")} title={t("poison.title")}>
      <div className="flex flex-col divide-y divide-line">
        {poison.rows.map((row: PoisonedExecutionConsumer) => {
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
                {row.lastErrorReason ?? missing}
              </div>
              {command ? (
                <pre className="mt-3 overflow-x-auto rounded-lg bg-ivory p-3 text-[11px] text-ink">
                  {command}
                </pre>
              ) : (
                <p className="mt-2 text-xs text-danger">
                  <span aria-hidden>✗ </span>
                  {t("poison.incomplete")}
                </p>
              )}
            </article>
          );
        })}
        {poison.rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-mute">{t("poison.empty")}</p>
        ) : null}
      </div>
      <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-mute">
        <span>{t("poison.count", { total: poison.total })}</span>
        <span className="flex items-center gap-4">
          {cursor ? (
            <Link
              className="font-semibold text-ink underline"
              href="/admin/execution-host"
            >
              {t("poison.first")}
            </Link>
          ) : null}
          {poison.nextAfter ? (
            <Link
              className="font-semibold text-ink underline"
              href={{
                pathname: "/admin/execution-host",
                query: {
                  poisonRun: poison.nextAfter.runId,
                  poisonConsumer: poison.nextAfter.consumerName,
                },
              }}
            >
              {t("poison.next")}
            </Link>
          ) : null}
        </span>
      </div>
    </Panel>
  );
}

function WorkerRows({
  states,
  t,
}: {
  states: Readonly<Record<string, DurableWorkerState>>;
  t: Translate;
}): ReactElement {
  return (
    <dl className="divide-y divide-line px-5">
      {Object.entries(states).map(([name, worker]) => (
        <div
          key={name}
          className="flex items-center justify-between gap-3 py-3"
        >
          <dt className="font-mono text-xs text-ink">{name}</dt>
          <dd>
            <Badge
              tone={
                worker.state === "running"
                  ? "good"
                  : worker.state === "stopped"
                    ? "neutral"
                    : "warn"
              }
            >
              {t(`workerState.${worker.state}`)}
              {worker.reason ? ` · ${worker.reason}` : ""}
            </Badge>
          </dd>
        </div>
      ))}
      {Object.keys(states).length === 0 ? (
        <div className="py-3 text-xs text-mute">{t("missing")}</div>
      ) : null}
    </dl>
  );
}

export async function ExecutionHostStatus({
  status,
  poisonCursor,
}: {
  status: AdminExecutionHostStatus;
  poisonCursor?: { runId: string; consumerName: string } | undefined;
}): Promise<ReactElement> {
  const [t, locale] = await Promise.all([
    getTranslations("adminExecutionHost"),
    getLocale(),
  ]);
  const missing = t("missing");
  const format: Format = {
    t,
    missing,
    time: (value) => formatInstant(value, missing, locale),
    span: (value) => formatDuration(value, missing),
  };
  const latestSweep = isPanelUnavailable(status.latestSweep)
    ? null
    : status.latestSweep;
  const observation = latestSweep?.observation;
  const lag = isPanelUnavailable(status.lag) ? null : status.lag;

  return (
    <div className="flex flex-col gap-5">
      <HostsPanel format={format} hosts={status.hosts} />

      {lag === null ? (
        <Panel subtitle={t("streams.subtitle")} title={t("streams.title")}>
          <PanelUnavailable t={t} />
        </Panel>
      ) : (
        <>
          <StreamsPanel
            format={format}
            observation={observation}
            streams={lag.streams}
          />
          <ConsumersPanel consumers={lag.consumers} format={format} />
          <PoisonPanel
            cursor={poisonCursor}
            format={format}
            poison={lag.poison}
          />
        </>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel subtitle={t("workers.subtitle")} title={t("workers.title")}>
          <div className="border-b border-line px-5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
            {t("workers.current")}
          </div>
          <WorkerRows states={status.workers} t={t} />
          <div className="border-y border-line px-5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-mute">
            {t("workers.latestSweep")}
            <span className="ml-2 normal-case tracking-normal">
              {observation
                ? t("workers.latestSweepMeta", {
                    observer: observation.observerId,
                    sampledAt: format.time(observation.sampledAt),
                  })
                : missing}
            </span>
          </div>
          <WorkerRows states={observation?.workers.states ?? {}} t={t} />
        </Panel>

        <Panel subtitle={t("commands.subtitle")} title={t("commands.title")}>
          {lag === null ? (
            <PanelUnavailable t={t} />
          ) : (
            <dl className="grid grid-cols-2 gap-4 px-5 py-4 text-sm">
              <div>
                <dt className="text-mute">{t("fields.open")}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {lag.commands.total}
                </dd>
              </div>
              <div>
                <dt className="text-mute">{t("fields.accepted")}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {lag.commands.accepted}
                </dd>
              </div>
              <div>
                <dt className="text-mute">{t("fields.oldest")}</dt>
                <dd className="mt-1">
                  {format.span(lag.commands.oldestAcceptedAgeMs)}
                </dd>
              </div>
              <div>
                <dt className="text-mute">{t("fields.impasse")}</dt>
                <dd className="mt-1 text-xl font-semibold">
                  {observation?.commands.impasse ?? "—"}
                </dd>
              </div>
              {lag.commands.hostSpan.map((host) => (
                <div
                  key={host.executionHostId}
                  className="col-span-2 grid grid-cols-3 gap-4 border-t border-line pt-3"
                >
                  <p className="col-span-3 font-mono text-xs text-mute">
                    {t("commands.hostSpan", { hostId: host.executionHostId })}
                  </p>
                  <div>
                    <dt className="text-mute">
                      {t("fields.hostSpanUnconfirmed")}
                    </dt>
                    <dd className="mt-1 text-xl font-semibold">
                      {host.hostSpanUnconfirmed}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mute">
                      {t("fields.hostSpanSettled1h")}
                    </dt>
                    <dd className="mt-1 text-xl font-semibold">
                      {host.hostSpanSettled1h}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mute">
                      {t("fields.postHocConflicts")}
                    </dt>
                    <dd className="mt-1 text-xl font-semibold">
                      {host.postHocConflicts}
                    </dd>
                  </div>
                </div>
              ))}
            </dl>
          )}
          <p className="border-t border-line px-5 py-3 text-xs text-mute">
            {observation
              ? t("commands.latestSweep", {
                  sampledAt: format.time(observation.sampledAt),
                })
              : missing}
          </p>
        </Panel>

        <ClockPanel clock={status.schedulerClock} format={format} />
      </div>

      <p className="font-mono text-[10px] text-mute">
        {t("sampledAt", { value: format.time(status.sampledAt) })}
      </p>
    </div>
  );
}

function ClockPanel({
  clock,
  format,
}: {
  clock: SchedulerClockStatus;
  format: Format;
}): ReactElement {
  const { t, time } = format;

  return (
    <Panel subtitle={t("clock.subtitle")} title={t("clock.title")}>
      <div className="px-5 py-4 text-sm">
        <Badge tone={clock.driver === "missing_tick" ? "danger" : "good"}>
          {t(`driver.${clock.driver}`)}
        </Badge>
        <p className="mt-3 text-mute">
          {t("clock.last", { value: time(clock.health.lastFinishedAt) })}
        </p>
        <Link
          className="mt-3 inline-flex font-semibold text-ink underline"
          href="/admin/scheduler"
        >
          {t("clock.open")}
        </Link>
      </div>
    </Panel>
  );
}
