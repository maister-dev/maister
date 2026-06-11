import type { ReactElement, ReactNode } from "react";

// Pure presentational pieces for the installed-package viewer (T1.3). All are
// Server Components: props in, markup out — no fetch, no DB, no client state, so
// they render under renderToStaticMarkup (no jsdom) in the unit tests. The
// absolute `installedPath` (§3.1) never crosses into these props; only the
// client-safe header DTO, the per-file read STATE, and file CONTENT do.

export interface PackageViewerHeaderLabels {
  versionLabel: string;
  resolvedRevision: string;
  enablement: string;
  trust: string;
  execTrust: string;
  trustUntrusted: string;
  trustTrusted: string;
  trustTrustedByPolicy: string;
  execUntrusted: string;
  execTrusted: string;
}

export interface PackageViewerHeaderProps {
  flowRef: string;
  versionLabel: string;
  resolvedRevision: string;
  enablementState: string;
  trustStatus: string;
  execTrust: string;
  labels: PackageViewerHeaderLabels;
}

function trustLabel(trust: string, labels: PackageViewerHeaderLabels): string {
  if (trust === "trusted") return labels.trustTrusted;
  if (trust === "trusted_by_policy") return labels.trustTrustedByPolicy;

  return labels.trustUntrusted;
}

function HeaderTag({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ivory px-2.5 py-1 font-mono text-[10.5px] text-ink-2">
      <span className="text-mute">{label}</span>
      <b className="font-semibold text-ink">{value}</b>
    </span>
  );
}

export function PackageViewerHeader({
  flowRef,
  versionLabel,
  resolvedRevision,
  enablementState,
  trustStatus,
  execTrust,
  labels,
}: PackageViewerHeaderProps): ReactElement {
  return (
    <header
      className="mb-6 border-b border-line pb-5"
      data-testid="package-viewer-header"
    >
      <h1 className="m-0 font-mono text-[24px] font-bold tracking-[-0.01em] text-ink">
        {flowRef}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <HeaderTag label={labels.versionLabel} value={versionLabel} />
        <HeaderTag
          label={labels.resolvedRevision}
          value={resolvedRevision.slice(0, 12)}
        />
        <HeaderTag label={labels.enablement} value={enablementState} />
        <HeaderTag
          label={labels.trust}
          value={trustLabel(trustStatus, labels)}
        />
        <HeaderTag
          label={labels.execTrust}
          value={
            execTrust === "trusted" ? labels.execTrusted : labels.execUntrusted
          }
        />
      </div>
    </header>
  );
}

export interface PackageFileViewLabels {
  binary: string;
  tooLarge: string;
  notFound: string;
  bundleMissing: string;
  emptyPrompt: string;
}

// Mirrors readInstalledPackageFile's ReadResult union, minus the disk handle.
export type PackageFileReadState =
  | { state: "text"; content: string; kind: string }
  | { state: "binary" }
  | { state: "too-large" }
  | { state: "not-found" }
  | { state: "bundle-missing" };

export interface PackageFileViewProps {
  relPath: string | null;
  state: PackageFileReadState | null;
  labels: PackageFileViewLabels;
  // The page passes a read-only CodeMirror host for the `text` state (the rich
  // editor is "use client" + ssr:false, so it cannot render server-side); when
  // absent (unit tests) the raw content renders in a <pre> fallback. Same
  // "pass the client widget as a prop" convention as WorkbenchPanel's `graph`.
  editor?: ReactNode;
}

function FileStateBanner({
  state,
  message,
}: {
  state: string;
  message: string;
}): ReactElement {
  return (
    <div
      className="rounded-lg border border-dashed border-line bg-paper px-4 py-6 text-center font-mono text-[12px] text-mute"
      data-file-state={state}
    >
      {message}
    </div>
  );
}

export function PackageFileView({
  relPath,
  state,
  labels,
  editor,
}: PackageFileViewProps): ReactElement {
  if (relPath === null || state === null) {
    return <FileStateBanner message={labels.emptyPrompt} state="empty" />;
  }

  switch (state.state) {
    case "text":
      return (
        <div data-file-state="text">
          {editor ?? (
            <pre className="overflow-auto rounded-lg border border-line bg-ivory p-3 font-mono text-[12px] leading-[1.5] text-ink">
              {state.content}
            </pre>
          )}
        </div>
      );
    case "binary":
      return <FileStateBanner message={labels.binary} state="binary" />;
    case "too-large":
      return <FileStateBanner message={labels.tooLarge} state="too-large" />;
    case "not-found":
      return <FileStateBanner message={labels.notFound} state="not-found" />;
    case "bundle-missing":
      return (
        <FileStateBanner
          message={labels.bundleMissing}
          state="bundle-missing"
        />
      );
  }
}

export interface PackageBundleMissingNoticeProps {
  message: string;
}

// The degraded files-section notice (expectation 8.1.3): the bundle dir is gone,
// but the header + graph still render from the DB manifest; this states why the
// files are unavailable without throwing.
export function PackageBundleMissingNotice({
  message,
}: PackageBundleMissingNoticeProps): ReactElement {
  return (
    <div
      className="rounded-lg border border-dashed border-amber-line bg-amber-soft px-4 py-6 text-center font-mono text-[12px] text-amber"
      data-testid="package-bundle-missing"
    >
      {message}
    </div>
  );
}
