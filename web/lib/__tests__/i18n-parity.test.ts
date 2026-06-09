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
