import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ru from "@/messages/ru.json";

// RU snapshot: resolve `useTranslations(ns)` against the REAL ru.json catalog
// (with minimal ICU {var} interpolation) so the rendered markup carries actual
// Russian labels — proving EN+RU parity is consumed, not just declared.
function lookup(ns: string, key: string): unknown {
  return `${ns}.${key}`
    .split(".")
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      ru,
    );
}

function interpolate(
  template: string,
  values?: Record<string, unknown>,
): string {
  if (!values) return template;

  return template.replace(/\{(\w+)\}/g, (_m, name) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}

vi.mock("next-intl", () => ({
  useTranslations:
    (ns: string) => (key: string, values?: Record<string, unknown>) => {
      const found = lookup(ns, key);

      return typeof found === "string"
        ? interpolate(found, values)
        : `${ns}.${key}`;
    },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AutoPromotionSettingsControl } from "@/components/board/panels/auto-promotion-settings-control";

describe("AutoPromotionSettingsControl — RU labels", () => {
  it("renders the Russian title, master toggle, and deny-list labels", () => {
    const html = renderToStaticMarkup(
      createElement(AutoPromotionSettingsControl, {
        projectSlug: "demo",
        config: null,
      }),
    );

    // Real RU strings from messages/ru.json (settings.autoPromotion.*).
    expect(html).toContain("Полосы авто-промоушена");
    expect(html).toContain("Авто-промоушен диффов в границах полос");
    expect(html).toContain("Всегда исключены (не настраивается)");
    // The default-mode label is localized in the table.
    expect(html).toContain("По умолчанию проекта");
    // The Save/Reset actions come from the shared settings namespace (RU).
    expect(html).toContain(ru.settings.save);
    expect(html).toContain(ru.settings.autoPromotion.reset);
  });
});
