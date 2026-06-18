import type { TokenAuditEntry } from "@/lib/tokens/audit-list";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — surfacing token_audit_log in the project Integrations
// tab (point 2). The implementor MUST create
// `@/components/board/panels/token-audit-table` exporting:
//
//   1. TokenAuditLabels — the prop type carrying every visible string.
//   2. TokenAuditTable({ slug, rows, total, page, pageSize, filters,
//        tokenOptions, labels }) — a PURE, hook-free presentational component
//        (renderToStaticMarkup-safe). It renders, per row, the actor label,
//        method, endpoint, scope used, a result label, and status code.
//        Renders the `empty` message when rows=[]. Renders a GET-form filter
//        (token + result) and URL-synchronized pagination links that ALWAYS
//        carry `tab=integrations` and preserve the active filters.
//
// The audit log is read-only and admin-only; the async Server Component that
// wires getTranslations is NOT tested here (not renderToStaticMarkup-safe).
// ---------------------------------------------------------------------------

import {
  TokenAuditTable,
  type TokenAuditLabels,
} from "@/components/board/panels/token-audit-table";

const labels: TokenAuditLabels = {
  title: "Token activity",
  description: "Actions performed via API tokens, not from the web UI.",
  empty: "No token activity yet.",
  colWhen: "When",
  colToken: "Token",
  colMethod: "Method",
  colEndpoint: "Endpoint",
  colScope: "Scope",
  colResult: "Result",
  colStatus: "Status",
  filterToken: "Token",
  filterResult: "Result",
  filterAny: "Any",
  resultOk: "OK",
  resultError: "Error",
  apply: "Apply",
  pagePrev: "Prev",
  pageNext: "Next",
  pageInfo: "{page} / {pages}",
};

const NOW = Date.UTC(2026, 5, 18);

const rows: TokenAuditEntry[] = [
  {
    id: "aud-1",
    tokenId: "tok-personal",
    actorLabel: "token:personal-agent",
    scopeUsed: "tasks:create",
    endpoint: "/api/v1/ext/projects/demo/tasks",
    method: "POST",
    result: "ok",
    statusCode: 201,
    createdAt: new Date(NOW),
  },
  {
    id: "aud-2",
    tokenId: "tok-personal",
    actorLabel: "token:personal-agent",
    scopeUsed: "hitl:respond",
    endpoint: "/api/v1/ext/runs/r1/hitl/h1/respond",
    method: "POST",
    result: "error",
    statusCode: 403,
    createdAt: new Date(NOW - 1000),
  },
];

const tokenOptions = [{ id: "tok-personal", name: "personal-agent" }];

function render(
  props: Partial<Parameters<typeof TokenAuditTable>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(TokenAuditTable, {
      slug: "demo",
      rows,
      total: 2,
      page: 1,
      pageSize: 50,
      filters: {},
      tokenOptions,
      labels,
      ...props,
    }),
  );
}

describe("TokenAuditTable — renders audit entries", () => {
  const html = render();

  it("renders the title and the not-from-web description", () => {
    expect(html).toContain(labels.title);
    expect(html).toContain(labels.description);
  });

  it("renders each entry's actor label, method, endpoint, scope, and status", () => {
    for (const row of rows) {
      expect(html).toContain(row.actorLabel);
      expect(html).toContain(row.endpoint);
      expect(html).toContain(row.scopeUsed);
      expect(html).toContain(String(row.statusCode));
    }
  });

  it("renders both result labels for a mixed ok/error set", () => {
    expect(html).toContain(labels.resultOk);
    expect(html).toContain(labels.resultError);
  });

  it("renders the token filter option names and result filter labels", () => {
    expect(html).toContain("personal-agent");
    expect(html).toContain(labels.filterResult);
    expect(html).toContain(labels.apply);
  });
});

describe("TokenAuditTable — empty state", () => {
  const html = render({ rows: [], total: 0 });

  it("renders the empty message and no endpoint rows", () => {
    expect(html).toContain(labels.empty);
    expect(html).not.toContain("/api/v1/ext/projects/demo/tasks");
  });
});

describe("TokenAuditTable — pagination preserves tab and filters", () => {
  const html = render({
    page: 2,
    total: 120,
    filters: { result: "error", tokenId: "tok-personal" },
  });

  it("renders prev/next links that stay on the integrations tab", () => {
    expect(html).toContain("tab=integrations");
    expect(html).toContain(labels.pageNext);
    expect(html).toContain(labels.pagePrev);
  });

  it("carries the active filters and the target page into the next link", () => {
    expect(html).toContain("audit_result=error");
    expect(html).toContain("audit_token=tok-personal");
    expect(html).toContain("audit_page=3");
  });

  it("omits the page param when linking back to page 1", () => {
    // pageHref(1) must NOT set audit_page=1 (page 1 is the canonical no-param state)
    expect(html).not.toContain("audit_page=1");
  });
});
