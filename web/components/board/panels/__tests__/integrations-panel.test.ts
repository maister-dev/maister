import type { TokenListItem } from "@/lib/tokens/list";

import { readFileSync } from "node:fs";
import path from "node:path";

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
  kindLabel: "Kind",
  kindProject: "Project token",
  kindUser: "User token",
  scopesLabel: "Scopes",
  cancel: "Cancel",
  confirm: "Create",
  secretTitle: "Copy your token now",
  secretWarning: "This secret is shown once and cannot be retrieved later.",
  copy: "Copy",
  copied: "Copied",
  revoke: "Revoke",
  edit: "Edit",
  editTitle: "Edit API token",
  editSaved: "Saved",
  save: "Save",
  scopesRequired: "Pick at least one scope, or revoke the token",
  revokeConfirm: "Revoke this token?",
  colName: "Name",
  colKind: "Kind",
  colScopes: "Scopes",
  colPrefix: "Prefix",
  colStatus: "Status",
  colCreated: "Created",
  colLastUsed: "Last used",
  colExpires: "Expires",
  statusActive: "Active",
  statusRevoked: "Revoked",
  statusExpired: "Expired",
  scopeAll: "Full project API",
  scopeTasksCreate: "Create tasks",
  scopeTasksRead: "Read tasks",
  scopeTasksUpdate: "Update tasks",
  scopeRunsLaunch: "Launch runs",
  scopeRunsRead: "Read runs",
  scopeReadinessRead: "Read readiness",
  scopeGatesReport: "Report gates",
  scopeHitlRead: "Read HITL",
  scopeHitlRequest: "Request agent clarification",
  scopeHitlRespond: "Respond to HITL",
  scopeHitlInboxRead: "Read personal HITL inbox",
  scopeDecisionsRead: "Read your decision queue",
  scopeNotificationsSubscriptions: "Manage your notification subscriptions",
  scopeHitlRespondHuman: "Respond to human HITL",
  scopeCommentsRead: "Read comments",
  scopeCommentsCreate: "Create comments",
  scopeTasksTriage: "Submit triage verdicts",
  scopeRelationsRead: "Read relations",
  scopeRelationsCreate: "Create relations",
  scopeRelationsDelete: "Delete relations",
  scopeFlowsRead: "Read flows",
  scopeRunnersRead: "Read runners",
  scopeAgentsTrigger: "Trigger agents",
  scopeRunsDelegate: "Delegate runs",
  scopeRunsCollect: "Collect child runs",
  scopeRunsCancel: "Cancel child runs",
  scopeRunsPromote: "Promote child runs",
  scopeRunsSync: "Sync & reopen runs",
  scopeRunsRecover: "Recover & discard runs",
  scopeMemoryRead: "Read project memory",
  scopeMemoryWrite: "Write project memory",
  scopeAgentMemoryWrite: "Write agent memory",
  errorGeneric: "Something went wrong",
};

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const activeToken: TokenListItem = {
  id: "tok-active",
  name: "ci-pipeline",
  kind: "project",
  ownerUserId: null,
  ownerLabel: null,
  scopes: ["*"],
  prefix: "mai_AAAA",
  createdAt: new Date(NOW - 10 * DAY),
  lastUsedAt: new Date(NOW - 1 * DAY),
  expiresAt: null,
  revokedAt: null,
};

const revokedToken: TokenListItem = {
  id: "tok-revoked",
  name: "old-deploy-key",
  kind: "user",
  ownerUserId: "user-owner",
  ownerLabel: "Owner User",
  scopes: ["tasks:create"],
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
  kind: "project",
  ownerUserId: null,
  ownerLabel: null,
  scopes: ["runs:launch", "gates:report"],
  prefix: "mai_CCCC",
  createdAt: new Date(NOW - 90 * DAY),
  lastUsedAt: null,
  expiresAt: new Date(NOW - 1 * DAY),
  revokedAt: null,
};

const multiScopeToken: TokenListItem = {
  id: "tok-multi",
  name: "ci-bot",
  kind: "project",
  ownerUserId: null,
  ownerLabel: null,
  scopes: ["board:read", "hitl:respond"],
  prefix: "mai_DDDD",
  createdAt: new Date(NOW - 2 * DAY),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

const fixtures: TokenListItem[] = [
  activeToken,
  revokedToken,
  expiredToken,
  multiScopeToken,
];

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
      // tokenDisplayStatus compares against the real clock, so the "future"
      // expiry must be relative to Date.now() — not the fixed fixture NOW (which
      // real time has since caught up to). (Pre-existing time-bomb fix.)
      expiresAt: new Date(Date.now() + 30 * DAY),
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

  it("renders kind, owner, and scope labels", () => {
    expect(html).toContain(labels.kindProject);
    expect(html).toContain(labels.kindUser);
    expect(html).toContain("Owner User");
    expect(html).toContain(labels.scopeAll);
    expect(html).toContain(labels.scopeTasksCreate);
    expect(html).toContain(labels.scopeRunsLaunch);
    expect(html).toContain(labels.scopeGatesReport);
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

// ---------------------------------------------------------------------------
// REGRESSION (ADR-168 D3). `IntegrationsPanel` is an async SERVER component,
// and `renderRevoke` runs during ITS render — not in the browser. When the
// row-level predicate `isManagedTokenRow` lived in `token-actions.tsx` (a
// `"use client"` module), React refused to invoke it from the server and the
// whole Integrations tab fell to the error boundary — but ONLY once the project
// had at least one token, because an empty table never calls the callback. The
// tests above render `TokensTable` directly and so never crossed that seam.
//
// A server component may RENDER a client component; it may not CALL a function
// a client module exports. Pin that: every value `integrations-panel.tsx` takes
// from `token-actions` must be a component, and the predicate must come from a
// module that is neither `"use client"` nor `server-only`.
// ---------------------------------------------------------------------------
describe("IntegrationsPanel — server/client module boundary", () => {
  const read = (relative: string): string =>
    readFileSync(path.resolve(process.cwd(), relative), "utf8");

  const PANEL = "components/board/panels/integrations-panel.tsx";
  const SHARED = "lib/tokens/managed-row.ts";
  const CLIENT = "components/board/token-actions.tsx";

  it("is a server component (no 'use client' directive)", () => {
    expect(read(PANEL)).not.toMatch(/^\s*["']use client["']/mu);
  });

  it("imports only components from the 'use client' token-actions module", () => {
    const source = read(PANEL);
    const block =
      /import\s*\{([^}]*)\}\s*from\s*["']@\/components\/board\/token-actions["']/u.exec(
        source,
      );

    expect(block, `${PANEL} must import from ${CLIENT}`).not.toBeNull();

    const bindings = (block as RegExpExecArray)[1]
      .split(",")
      .map((binding) => binding.trim())
      .filter((binding) => binding.length > 0)
      .map((binding) => binding.split(/\s+as\s+/u).pop() as string);

    expect(bindings.length).toBeGreaterThan(0);

    for (const binding of bindings) {
      expect(
        binding,
        `${binding} is not a component — a server component may render a client component, but never call a client export`,
      ).toMatch(/^[A-Z]/u);
    }
  });

  it("takes isManagedTokenRow from the shared module, not the client one", () => {
    expect(read(PANEL)).toMatch(
      /import\s*\{\s*isManagedTokenRow\s*\}\s*from\s*["']@\/lib\/tokens\/managed-row["']/u,
    );
    expect(read(CLIENT)).not.toMatch(/isManagedTokenRow/u);
  });

  it("keeps the shared module usable from both render sides", () => {
    const shared = read(SHARED);

    expect(shared).not.toMatch(/^\s*["']use client["']/mu);
    expect(shared).not.toMatch(/["']server-only["']/u);
    expect(shared).toMatch(/export function isManagedTokenRow/u);
  });
});
