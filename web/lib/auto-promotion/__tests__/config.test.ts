import { afterEach, describe, expect, it } from "vitest";

import {
  autoPromotionEnabledFromEnv,
  BUILT_IN_LANES,
  laneClassSchema,
  resolveAutoPromotionConfig,
} from "@/lib/auto-promotion/config";

describe("resolveAutoPromotionConfig", () => {
  it("NULL column ⇒ shipped defaults with master OFF (source=default)", () => {
    const r = resolveAutoPromotionConfig({ id: "p1", autoPromotion: null });

    expect(r.source).toBe("default");
    expect(r.config.enabled).toBe(false);
    expect(r.config.lanes).toEqual(BUILT_IN_LANES);
  });

  it("undefined column is treated as NULL (default)", () => {
    const r = resolveAutoPromotionConfig({ id: "p1" });

    expect(r.source).toBe("default");
    expect(r.config.enabled).toBe(false);
  });

  it("valid stored config ⇒ source=stored, values preserved, delayMinutes defaulted", () => {
    const r = resolveAutoPromotionConfig({
      id: "p1",
      autoPromotion: {
        enabled: true,
        lanes: [{ class: "docs", enabled: true }],
      },
    });

    expect(r.source).toBe("stored");
    expect(r.config.enabled).toBe(true);
    expect(r.config.lanes).toEqual([
      { class: "docs", enabled: true, delayMinutes: 10 },
    ]);
  });

  it("malformed stored config ⇒ source=invalid, fail-closed to disabled (never throws)", () => {
    const r = resolveAutoPromotionConfig({
      id: "p1",
      autoPromotion: { enabled: "nope" },
    });

    expect(r.source).toBe("invalid");
    expect(r.config.enabled).toBe(false);
  });

  it("unknown key ⇒ invalid (strict schema)", () => {
    const r = resolveAutoPromotionConfig({
      id: "p1",
      autoPromotion: { enabled: true, lanes: [], surprise: 1 },
    });

    expect(r.source).toBe("invalid");
  });

  it("duplicate lane class is deduped, keeping the first", () => {
    const r = resolveAutoPromotionConfig({
      id: "p1",
      autoPromotion: {
        enabled: true,
        lanes: [
          { class: "docs", enabled: true, delayMinutes: 5 },
          { class: "docs", enabled: false, delayMinutes: 99 },
        ],
      },
    });

    expect(r.config.lanes).toHaveLength(1);
    expect(r.config.lanes[0]).toMatchObject({
      class: "docs",
      enabled: true,
      delayMinutes: 5,
    });
  });
});

describe("BUILT_IN_LANES", () => {
  it("covers all four classes, enabled, 10-min grace, no overrides", () => {
    expect(BUILT_IN_LANES).toHaveLength(4);
    expect(BUILT_IN_LANES.map((l) => l.class).sort()).toEqual(
      [...laneClassSchema.options].sort(),
    );

    for (const lane of BUILT_IN_LANES) {
      expect(lane.enabled).toBe(true);
      expect(lane.delayMinutes).toBe(10);
      expect(lane.mode).toBeUndefined();
      expect(lane.requireExternalCheckId).toBeUndefined();
      expect(lane.excludeGlobs).toBeUndefined();
    }
  });
});

describe("autoPromotionEnabledFromEnv", () => {
  const original = process.env.MAISTER_AUTO_PROMOTION;

  afterEach(() => {
    if (original === undefined) delete process.env.MAISTER_AUTO_PROMOTION;
    else process.env.MAISTER_AUTO_PROMOTION = original;
  });

  it("unset ⇒ on", () => {
    delete process.env.MAISTER_AUTO_PROMOTION;
    expect(autoPromotionEnabledFromEnv()).toBe(true);
  });

  it("literal 'off' (case-insensitive) ⇒ off", () => {
    process.env.MAISTER_AUTO_PROMOTION = "OFF";
    expect(autoPromotionEnabledFromEnv()).toBe(false);
    process.env.MAISTER_AUTO_PROMOTION = " off ";
    expect(autoPromotionEnabledFromEnv()).toBe(false);
  });

  it("any other value ⇒ on", () => {
    process.env.MAISTER_AUTO_PROMOTION = "on";
    expect(autoPromotionEnabledFromEnv()).toBe(true);
    process.env.MAISTER_AUTO_PROMOTION = "garbage";
    expect(autoPromotionEnabledFromEnv()).toBe(true);
  });
});
