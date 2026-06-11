// Presentational render tests for the installed-package viewer (T1.3/T1.4,
// expectations 8.1.1-4). Uses renderToStaticMarkup (no jsdom), mirroring
// components/board/__tests__/flow-graph-view.test.ts.
//
// These cover the PURE sub-components extracted so the viewer page's markup is
// unit-testable: the header (ref/version/sha/trust/execTrust), the per-file
// state renderer (text | binary | too-large | not-found | bundle-missing), and
// the degraded bundle-missing files notice. The RSC page's DB + disk wiring is
// exercised by the Phase-2 e2e (T2.5), NOT here — these assert only that each
// presentational state emits its distinct, translated markup.
//
// installedPath (absolute server handle) is INTENTIONALLY absent from every
// prop these components accept (§3.1) — there is no way to leak it here.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PackageBundleMissingNotice,
  PackageFileView,
  PackageViewerHeader,
  type PackageFileViewLabels,
  type PackageViewerHeaderLabels,
} from "@/components/flows/package-viewer";

const headerLabels: PackageViewerHeaderLabels = {
  versionLabel: "Version",
  resolvedRevision: "Resolved revision",
  enablement: "State",
  trust: "Trust",
  execTrust: "Executable trust",
  trustUntrusted: "Untrusted",
  trustTrusted: "Trusted",
  trustTrustedByPolicy: "Trusted by policy",
  execUntrusted: "Scripts blocked",
  execTrusted: "Scripts allowed",
};

const fileLabels: PackageFileViewLabels = {
  binary: "Binary file — not shown",
  tooLarge: "File too large to display",
  notFound: "File not found",
  bundleMissing: "Bundle not available on disk",
  emptyPrompt: "Select a file to view",
};

describe("PackageViewerHeader — installed package metadata", () => {
  it("renders ref, version, resolved SHA (short), enablement, trust and exec-trust", () => {
    const html = renderToStaticMarkup(
      createElement(PackageViewerHeader, {
        flowRef: "bugfix",
        versionLabel: "v1.2.3",
        resolvedRevision: "0123456789abcdef0123456789abcdef01234567",
        enablementState: "Enabled",
        trustStatus: "trusted",
        execTrust: "untrusted",
        labels: headerLabels,
      }),
    );

    expect(html).toContain("bugfix");
    expect(html).toContain("v1.2.3");
    // short SHA (first 12 hex), never the full 40.
    expect(html).toContain("0123456789ab");
    expect(html).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(html).toContain("Enabled");
    // trust + exec-trust surfaced with their honest labels.
    expect(html).toContain("Trusted");
    expect(html).toContain("Scripts blocked");
  });

  it("surfaces an untrusted package and trusted scripts distinctly", () => {
    const html = renderToStaticMarkup(
      createElement(PackageViewerHeader, {
        flowRef: "spec-kit",
        versionLabel: "v0.4.1",
        resolvedRevision: "abcdef0123456789abcdef0123456789abcdef01",
        enablementState: "Disabled",
        trustStatus: "untrusted",
        execTrust: "trusted",
        labels: headerLabels,
      }),
    );

    expect(html).toContain("Untrusted");
    expect(html).toContain("Scripts allowed");
    expect(html).toContain("Disabled");
  });
});

describe("PackageFileView — per-state markup", () => {
  it("renders text content for a text file", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFileView, {
        relPath: "skills/plan/SKILL.md",
        state: { state: "text", content: "# Plan skill body", kind: "skill" },
        labels: fileLabels,
      }),
    );

    expect(html).toContain('data-file-state="text"');
    expect(html).toContain("# Plan skill body");
    // No state-message banner on a healthy text read.
    expect(html).not.toContain("File not found");
  });

  it("renders the binary message (not the bytes) for a binary file", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFileView, {
        relPath: "assets/logo.png",
        state: { state: "binary" },
        labels: fileLabels,
      }),
    );

    expect(html).toContain('data-file-state="binary"');
    expect(html).toContain("Binary file — not shown");
  });

  it("renders the too-large message for an oversized file", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFileView, {
        relPath: "assets/huge.bin",
        state: { state: "too-large" },
        labels: fileLabels,
      }),
    );

    expect(html).toContain('data-file-state="too-large"');
    expect(html).toContain("File too large to display");
  });

  it("renders the not-found message for a missing/rejected path", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFileView, {
        relPath: "../escape",
        state: { state: "not-found" },
        labels: fileLabels,
      }),
    );

    expect(html).toContain('data-file-state="not-found"');
    expect(html).toContain("File not found");
  });

  it("renders the bundle-missing message when the bundle dir is gone", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFileView, {
        relPath: "schemas/review.json",
        state: { state: "bundle-missing" },
        labels: fileLabels,
      }),
    );

    expect(html).toContain('data-file-state="bundle-missing"');
    expect(html).toContain("Bundle not available on disk");
  });

  it("renders the empty prompt when no file is selected", () => {
    const html = renderToStaticMarkup(
      createElement(PackageFileView, {
        relPath: null,
        state: null,
        labels: fileLabels,
      }),
    );

    expect(html).toContain('data-file-state="empty"');
    expect(html).toContain("Select a file to view");
  });
});

describe("PackageBundleMissingNotice — degraded files section", () => {
  it("renders the typed bundle-not-available notice", () => {
    const html = renderToStaticMarkup(
      createElement(PackageBundleMissingNotice, {
        message: "Bundle not available on disk",
      }),
    );

    expect(html).toContain('data-testid="package-bundle-missing"');
    expect(html).toContain("Bundle not available on disk");
  });
});
