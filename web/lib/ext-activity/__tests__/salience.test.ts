import { describe, expect, it } from "vitest";

import {
  filterBySalience,
  meetsSalience,
  salienceRank,
} from "@/lib/ext-activity/salience";

describe("ext activity salience helpers", () => {
  it("treats salience as a minimum threshold", () => {
    expect(meetsSalience("high", "high")).toBe(true);
    expect(meetsSalience("normal", "high")).toBe(false);
    expect(meetsSalience("normal", "normal")).toBe(true);
    expect(meetsSalience("low", "normal")).toBe(false);
  });

  it("orders high above normal above low", () => {
    expect(salienceRank("high")).toBeGreaterThan(salienceRank("normal"));
    expect(salienceRank("normal")).toBeGreaterThan(salienceRank("low"));
  });

  it("filters collections without changing item order", () => {
    const items = [
      { id: "a", salience: "low" as const },
      { id: "b", salience: "high" as const },
      { id: "c", salience: "normal" as const },
      { id: "d", salience: "high" as const },
    ];

    expect(filterBySalience(items, "high").map((item) => item.id)).toEqual([
      "b",
      "d",
    ]);
    expect(filterBySalience(items, "normal").map((item) => item.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });
});
