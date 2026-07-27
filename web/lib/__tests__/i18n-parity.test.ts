import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

// M27/T-A7: enforce EN/RU key-for-key parity (previously "by convention").
// A missing or extra key in either locale fails here rather than rendering a
// raw key path to a user.
function keyTree(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];

  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...keyTree(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }

  return keys.sort();
}

// T-C9b (ADR-152): the memory surface's keys live in the `agentsAttach`
// namespace — verified against the catalogs, NOT the `projectSettings.agents`
// the screen doc used to name, which exists in neither file.
describe("T-C9b — agent-memory keys are complete in both catalogs", () => {
  const MEMORY_KEYS = [
    "memoryAction",
    "memoryTitle",
    "memoryClose",
    "memoryEdit",
    "memorySave",
    "memoryCancel",
    "memoryClear",
    "memoryClearConfirm",
    "memoryEmpty",
    "memorySize",
    "memoryOverCap",
    "memoryConflict",
    "memoryLoadError",
    "memoryToggle",
    "memoryFlowBound",
  ];

  it.each(["en", "ru"] as const)(
    "%s carries every agentsAttach memory key with non-empty copy",
    (locale) => {
      const ns = (locale === "en" ? en : ru).agentsAttach as Record<
        string,
        string
      >;

      for (const key of MEMORY_KEYS) {
        expect(ns[key], `${locale}.agentsAttach.${key}`).toBeTruthy();
      }
    },
  );

  it("the size indicator template exposes both placeholders in both locales", () => {
    for (const ns of [en.agentsAttach, ru.agentsAttach] as Array<
      Record<string, string>
    >) {
      expect(ns.memorySize).toContain("{size}");
      expect(ns.memorySize).toContain("{max}");
    }
  });

  it("RU copy is actually translated, not an EN duplicate", () => {
    const enNs = en.agentsAttach as Record<string, string>;
    const ruNs = ru.agentsAttach as Record<string, string>;

    for (const key of [
      "memoryTitle",
      "memoryClearConfirm",
      "memoryFlowBound",
    ]) {
      expect(ruNs[key]).not.toBe(enNs[key]);
    }
  });
});

describe("i18n en/ru parity", () => {
  it("en and ru have identical key trees", () => {
    expect(keyTree(en as Record<string, unknown>)).toEqual(
      keyTree(ru as Record<string, unknown>),
    );
  });

  it("the flowEditor namespace is present in both locales", () => {
    expect(Object.prototype.hasOwnProperty.call(en, "flowEditor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(ru, "flowEditor")).toBe(true);
  });
});
