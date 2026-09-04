"use client";

import type { ReactElement } from "react";

import { useRepositorySummary } from "@/components/use-repository-summary";
import type { Locale } from "@/lib/locale";
import { GITHUB_REPOSITORY } from "@/lib/site-config";

type RepositoryLabels = {
  branch: string;
  connected: string;
  error: string;
  forks: string;
  issues: string;
  license: string;
  loading: string;
  retry: string;
  stars: string;
  updated: string;
};

type GitHubRepoWidgetProps = {
  labels: RepositoryLabels;
  locale: Locale;
};

type RepositoryMetric = {
  label: string;
  value: string;
};

type RepositoryMetricsProps = {
  isLoading?: boolean;
  metrics: ReadonlyArray<RepositoryMetric>;
};

function placeholderMetrics(labels: RepositoryLabels): ReadonlyArray<RepositoryMetric> {
  return [
    { label: labels.stars, value: "—" },
    { label: labels.forks, value: "—" },
    { label: labels.issues, value: "—" },
    { label: labels.license, value: "—" },
    { label: labels.branch, value: "—" },
    { label: labels.updated, value: "—" },
  ];
}

function RepositoryMetrics({
  isLoading = false,
  metrics,
}: RepositoryMetricsProps): ReactElement {
  return (
    <div className={`repo-metrics${isLoading ? " is-loading" : ""}`}>
      {metrics.map((metric) => (
        <div key={metric.label}>
          <span>{metric.label}</span>
          {isLoading ? (
            <i aria-hidden="true" className="repo-metric-skeleton" />
          ) : (
            <strong>{metric.value}</strong>
          )}
        </div>
      ))}
    </div>
  );
}

export function GitHubRepoWidget({
  labels,
  locale,
}: GitHubRepoWidgetProps): ReactElement {
  const { retry, state } = useRepositorySummary();

  if (state.status === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="repo-widget is-loading">
        <div className="repo-widget-head">
          <span className="repo-status is-loading">
            <span aria-hidden="true" />
            {labels.loading}
          </span>
          <span>{GITHUB_REPOSITORY}</span>
        </div>
        <RepositoryMetrics isLoading metrics={placeholderMetrics(labels)} />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="repo-widget is-error" role="alert">
        <div className="repo-widget-head">
          <span className="repo-status is-error">
            <span aria-hidden="true" />
            {labels.error}
          </span>
          <span className="repo-widget-head-actions">
            <span>{GITHUB_REPOSITORY}</span>
            <button className="text-button" type="button" onClick={retry}>
              {labels.retry} ↻
            </button>
          </span>
        </div>
        <RepositoryMetrics metrics={placeholderMetrics(labels)} />
      </div>
    );
  }

  const formatter = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(state.data.pushedAt));
  const metrics = [
    { label: labels.stars, value: formatter.format(state.data.stars) },
    { label: labels.forks, value: formatter.format(state.data.forks) },
    { label: labels.issues, value: formatter.format(state.data.openIssues) },
    { label: labels.license, value: state.data.license },
    { label: labels.branch, value: state.data.defaultBranch },
    { label: labels.updated, value: date },
  ];

  return (
    <div className="repo-widget is-ready">
      <div className="repo-widget-head">
        <span className="repo-status">
          <span aria-hidden="true" />
          {labels.connected}
        </span>
        <span>{state.data.fullName}</span>
      </div>
      <RepositoryMetrics metrics={metrics} />
    </div>
  );
}
