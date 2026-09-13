// @vitest-environment jsdom

// ADR-168 follow-up, found by adversarial review. Two defects in the personal
// token surface, both invisible to the service-layer suites:
//   1. Its dialogs carried `aria-modal="true"` and nothing else, so the row's
//      destructive Revoke button stayed in the tab order behind an open editor.
//   2. Its scope picker was a hand-maintained list that had drifted 8 scopes
//      behind the vocabulary — including the two grants ADR-168 exists to add.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string =>
      `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

import { PersonalTokensPanel } from "@/components/account/personal-tokens-panel";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(tokens: unknown[]): HTMLElement {
  const host = document.createElement("div");

  document.body.append(host);

  const root = createRoot(host);

  roots.push(root);
  act(() => {
    root.render(createElement(PersonalTokensPanel, { tokens } as never));
  });

  return host;
}

function activeToken(): Record<string, unknown> {
  return {
    id: "tok-1",
    name: "Personal agent",
    kind: "user",
    ownerUserId: "user-1",
    scopes: ["tasks:read"],
    humanHitl: false,
    prefix: "mai_abcd1234",
    createdAt: new Date("2026-01-01").toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
}

function byLabel(host: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(host.querySelectorAll<HTMLElement>("button")).find(
    (el) => el.getAttribute("aria-label") === label,
  );
}

describe("PersonalTokensPanel — editing must not expose Revoke", () => {
  it("moves focus into the dialog and keeps the destructive row action out of it", () => {
    const host = render([activeToken()]);
    const edit = byLabel(host, "account.personalTokens.actions.edit");

    expect(edit).toBeDefined();

    act(() => {
      edit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');

    expect(dialog).not.toBeNull();

    // Initial focus is inside the dialog — not left on the trigger, from where
    // the next Tab reaches the row's Revoke button.
    expect(dialog!.contains(document.activeElement)).toBe(true);

    // And the containment holds: every focusable the trap cycles through
    // belongs to the dialog, so Revoke is unreachable while it is open.
    const revoke = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("actions.revoke"),
    );

    expect(revoke).toBeDefined();
    expect(dialog!.contains(revoke!)).toBe(false);
  });
});

describe("PersonalTokensPanel — the scope picker is the whole vocabulary", () => {
  it("offers the grants ADR-168 exists to add after issuance", () => {
    const host = render([activeToken()]);
    const edit = byLabel(host, "account.personalTokens.actions.edit");

    act(() => {
      edit!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const labels = Array.from(
      host.querySelectorAll<HTMLElement>('[role="dialog"] label'),
    ).map((el) => el.textContent ?? "");

    for (const key of [
      "scopeLabels.flowsRead",
      "scopeLabels.runnersRead",
      "scopeLabels.gatesReport",
      "scopeLabels.memoryRead",
    ]) {
      expect(labels.some((l) => l.includes(key))).toBe(true);
    }

    // The exact-only human grant keeps its own checkbox and stays out of the
    // broad picker, as this surface's POST contract requires.
    expect(
      labels.filter((l) => l.includes("scopeLabels.hitlRespondHuman")),
    ).toHaveLength(0);
  });
});
