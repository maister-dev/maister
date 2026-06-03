import type { TokenListItem } from "@/lib/tokens/list";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — M16 Phase 5 "Integrations" token-management UI.
//
// The implementor MUST create `@/components/board/panels/integrations-panel`
// and from it RE-EXPORT (single contract location) the following:
//
//   1. tokenDisplayStatus(item: TokenListItem): "active" | "revoked" | "expired"
//        - revokedAt != null                                  -> "revoked"
//        - else expiresAt != null && expiresAt < now()        -> "expired"
//        - else                                               -> "active"
//        ("revoked" wins even when also expired.)
//
//   2. TokenLabels — the prop type carrying every visible string (mirrors
//      PackageLabels). The render tests below pass a literal of this shape.
//
//   3. TokensTable({ labels, tokens, isAdmin }) — a PURE, hook-free
//      presentational component (NO useRouter, NO next-intl hooks). It must be
//      renderToStaticMarkup-safe. Renders, per token, the name + prefix + a
//      status label + created date. Renders the create affordance label and a
//      per-row revoke affordance ONLY when isAdmin. Renders the `empty` message
//      when tokens=[]. Renders the `adminOnly` notice and NO token rows when
//      !isAdmin.
//
//   4. TokenSecretReveal({ secret, labels }) — a PURE, hook-free presentational
//      component. Displays the one-time secret verbatim, a copy affordance
//      (labels.copy), and carries role="alert".
//
// The async Server Component IntegrationsPanel({ tokens, slug, isAdmin }) that
// wires getTranslations("tokens") + delegates to TokensTable is NOT tested here
// (it calls async i18n; not renderToStaticMarkup-safe). These tests pin only
// the pure seams the implementor must expose.
//
// RED reason until implemented: module/exports do not exist
// (ERR_MODULE_NOT_FOUND / missing named export).
// ---------------------------------------------------------------------------

import {
  TokensTable,
  TokenSecretReveal,
  tokenDisplayStatus,
  type TokenLabels,
} from "@/components/board/panels/integrations-panel";

const labels: TokenLabels = {
  title: "Integrations",
  empty: "No tokens yet",
  adminOnly: "Admin only — ask a project admin",
  create: "Create token",
  createTitle: "Create API token",
  nameLabel: "Name",
  namePlaceholder: "ci-pipeline",
  expiresLabel: "Expires",
  cancel: "Cancel",
  confirm: "Create",
  secretTitle: "Copy your token now",
  secretWarning: "This secret is shown once and cannot be retrieved later.",
  copy: "Copy",
  copied: "Copied",
  revoke: "Revoke",
  revokeConfirm: "Revoke this token?",
  colName: "Name",
  colPrefix: "Prefix",
  colStatus: "Status",
  colCreated: "Created",
  colLastUsed: "Last used",
  colExpires: "Expires",
  statusActive: "Active",
  statusRevoked: "Revoked",
  statusExpired: "Expired",
  errorGeneric: "Something went wrong",
};

const NOW = Date.UTC(2026, 5, 2);
const DAY = 24 * 60 * 60 * 1000;

const activeToken: TokenListItem = {
  id: "tok-active",
  name: "ci-pipeline",
  prefix: "mai_AAAA",
  createdAt: new Date(NOW - 10 * DAY),
  lastUsedAt: new Date(NOW - 1 * DAY),
  expiresAt: null,
  revokedAt: null,
};

const revokedToken: TokenListItem = {
  id: "tok-revoked",
  name: "old-deploy-key",
  prefix: "mai_BBBB",
  createdAt: new Date(NOW - 30 * DAY),
  lastUsedAt: null,
  // Revoked AND in the past-expiry window — "revoked" must still win.
  expiresAt: new Date(NOW - 5 * DAY),
  revokedAt: new Date(NOW - 2 * DAY),
};

const expiredToken: TokenListItem = {
  id: "tok-expired",
  name: "temp-scanner",
  prefix: "mai_CCCC",
  createdAt: new Date(NOW - 90 * DAY),
  lastUsedAt: null,
  expiresAt: new Date(NOW - 1 * DAY),
  revokedAt: null,
};

const fixtures: TokenListItem[] = [activeToken, revokedToken, expiredToken];

function renderTable(tokens: TokenListItem[], isAdmin: boolean): string {
  return renderToStaticMarkup(
    createElement(TokensTable, { labels, tokens, isAdmin }),
  );
}

describe("tokenDisplayStatus — derivation helper (M16)", () => {
  it("returns 'active' for a token with no revoke and no expiry", () => {
    expect(tokenDisplayStatus(activeToken)).toBe("active");
  });

  it("returns 'revoked' when revokedAt is set", () => {
    expect(tokenDisplayStatus(revokedToken)).toBe("revoked");
  });

  it("returns 'expired' when expiresAt is in the past and not revoked", () => {
    expect(tokenDisplayStatus(expiredToken)).toBe("expired");
  });

  it("'revoked' wins even when the token is also past its expiry", () => {
    expect(tokenDisplayStatus(revokedToken)).toBe("revoked");
  });

  it("treats a future expiry as 'active'", () => {
    const future: TokenListItem = {
      ...activeToken,
      expiresAt: new Date(NOW + 30 * DAY),
    };

    expect(tokenDisplayStatus(future)).toBe("active");
  });
});

describe("TokensTable — renders data for an admin (M16)", () => {
  const html = renderTable(fixtures, true);

  it("renders each token's name and prefix", () => {
    for (const tok of fixtures) {
      expect(html).toContain(tok.name);
      expect(html).toContain(tok.prefix);
    }
  });

  it("renders a status label for active, revoked, and expired tokens", () => {
    expect(html).toContain(labels.statusActive);
    expect(html).toContain(labels.statusRevoked);
    expect(html).toContain(labels.statusExpired);
  });

  it("renders the create affordance label and a revoke affordance for an admin", () => {
    expect(html).toContain(labels.create);
    expect(html).toContain(labels.revoke);
  });
});

describe("TokensTable — admin gating (M16)", () => {
  const html = renderTable(fixtures, false);

  it("does NOT render the create affordance for a non-admin", () => {
    expect(html).not.toContain(labels.create);
  });

  it("does NOT render any revoke affordance for a non-admin", () => {
    expect(html).not.toContain(labels.revoke);
  });

  it("renders the adminOnly notice for a non-admin", () => {
    expect(html).toContain(labels.adminOnly);
  });

  it("does not list token rows for a non-admin", () => {
    for (const tok of fixtures) {
      expect(html).not.toContain(tok.prefix);
    }
  });
});

describe("TokensTable — empty state (M16)", () => {
  const html = renderTable([], true);

  it("renders the empty message when there are no tokens", () => {
    expect(html).toContain(labels.empty);
  });

  it("renders no token row / prefix when empty", () => {
    expect(html).not.toContain(activeToken.prefix);
  });
});

describe("TokenSecretReveal — one-time secret view (M16)", () => {
  const secret = "mai_AAAA.s3cr3t-one-time-value-do-not-leak";
  const html = renderToStaticMarkup(
    createElement(TokenSecretReveal, { secret, labels }),
  );

  it("displays the secret verbatim", () => {
    expect(html).toContain(secret);
  });

  it("renders the copy affordance label", () => {
    expect(html).toContain(labels.copy);
  });

  it('carries role="alert" for assistive tech', () => {
    expect(html).toContain('role="alert"');
  });
});

describe("TokensTable — no secret leak in the read-only table (M16)", () => {
  it("never renders a full-secret-shaped value (TokenListItem carries no secret)", () => {
    const html = renderTable(fixtures, true);

    // The list endpoint returns only `prefix`, never the secret. A full secret
    // is `<prefix>.<random>` — the rendered table must never contain a dotted
    // secret value. This guards against a regression where the create response
    // (which DOES carry the secret) gets passed into the list table.
    expect(html).not.toMatch(/mai_[A-Za-z0-9]+\.[A-Za-z0-9-]+/);
  });
});
