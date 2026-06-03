// RED (M15 Phase 1 §Task 3): Gate calibration schema — confidence_min + allow_missing_confidence.
//
// Frozen contract from docs/system-analytics/readiness.md:
// - Per-gate `calibration.confidence_min` (0..1) + `allow_missing_confidence` (default false)
// - Applies to `ai_judgment` + `skill_check` ONLY
// - Flow-level `verdict_calibration.confidence_min` default folds into gates at compile time
// - `human_review` gate with `mode: "blocking"` is REJECTED at manifest validation

import { describe, expect, it } from "vitest";

import { gateSchema, flowYamlV1Schema } from "@/lib/config.schema";

describe("config.schema — gate calibration (M15 §Task 3)", () => {
  describe("gateSchema — calibration.confidence_min + allow_missing_confidence", () => {
    it("accepts an ai_judgment gate with calibration.confidence_min", () => {
      const gate = {
        id: "judge",
        kind: "ai_judgment",
        mode: "blocking",
        calibration: {
          confidence_min: 0.8,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(
          (parsed.data as { calibration?: { confidence_min?: number } })
            .calibration?.confidence_min,
        ).toBe(0.8);
      }
    });

    it("accepts an ai_judgment gate with calibration.confidence_min + allow_missing_confidence", () => {
      const gate = {
        id: "judge",
        kind: "ai_judgment",
        mode: "blocking",
        calibration: {
          confidence_min: 0.8,
          allow_missing_confidence: true,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(
          (
            parsed.data as {
              calibration?: {
                confidence_min?: number;
                allow_missing_confidence?: boolean;
              };
            }
          ).calibration?.confidence_min,
        ).toBe(0.8);
        expect(
          (
            parsed.data as {
              calibration?: {
                confidence_min?: number;
                allow_missing_confidence?: boolean;
              };
            }
          ).calibration?.allow_missing_confidence,
        ).toBe(true);
      }
    });

    it("accepts a skill_check gate with calibration.confidence_min", () => {
      const gate = {
        id: "skill",
        kind: "skill_check",
        mode: "blocking",
        skill: "test-skill",
        calibration: {
          confidence_min: 0.7,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(true);
    });

    it("rejects confidence_min > 1.0 (out of valid range [0,1])", () => {
      const gate = {
        id: "judge",
        kind: "ai_judgment",
        mode: "blocking",
        calibration: {
          confidence_min: 1.5,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(false);
      expect(parsed.error?.message).toMatch(/confidence_min|1\.5|range|0.*1/i);
    });

    it("rejects confidence_min < 0 (out of valid range [0,1])", () => {
      const gate = {
        id: "judge",
        kind: "ai_judgment",
        mode: "blocking",
        calibration: {
          confidence_min: -0.1,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(false);
    });

    it("rejects calibration on a command_check gate (only valid on ai_judgment/skill_check)", () => {
      const gate = {
        id: "cmd",
        kind: "command_check",
        mode: "blocking",
        command: "test",
        calibration: {
          confidence_min: 0.8,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(false);
      expect(parsed.error?.message).toMatch(/calibration|command_check/i);
    });

    it("rejects calibration on an artifact_required gate", () => {
      const gate = {
        id: "artifact",
        kind: "artifact_required",
        mode: "blocking",
        inputArtifacts: ["diff"],
        calibration: {
          confidence_min: 0.8,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(false);
    });

    it("rejects calibration on an external_check gate", () => {
      const gate = {
        id: "external",
        kind: "external_check",
        mode: "blocking",
        calibration: {
          confidence_min: 0.8,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(false);
    });

    it("rejects calibration on a human_review gate", () => {
      const gate = {
        id: "human",
        kind: "human_review",
        mode: "advisory",
        calibration: {
          confidence_min: 0.8,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(false);
    });

    it("accepts calibration.allow_missing_confidence with default false when omitted", () => {
      const gate = {
        id: "judge",
        kind: "ai_judgment",
        mode: "blocking",
        calibration: {
          confidence_min: 0.8,
        },
      };

      const parsed = gateSchema.safeParse(gate);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // When allow_missing_confidence is omitted, it should either be undefined or default to false
        const allowMissing = (
          parsed.data as {
            calibration?: { allow_missing_confidence?: boolean };
          }
        ).calibration?.allow_missing_confidence;

        expect(allowMissing === undefined || allowMissing === false).toBe(true);
      }
    });
  });

  describe("flowYamlV1Schema — verdict_calibration.confidence_min", () => {
    it("accepts a flow with top-level verdict_calibration.confidence_min", () => {
      const flow = {
        schemaVersion: 1,
        name: "test-flow",
        verdict_calibration: {
          confidence_min: 0.7,
        },
        nodes: [
          {
            id: "judge",
            type: "judge",
            action: { prompt: "test" },
          },
        ],
      };

      const parsed = flowYamlV1Schema.safeParse(flow);

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(
          (parsed.data as { verdict_calibration?: { confidence_min?: number } })
            .verdict_calibration?.confidence_min,
        ).toBe(0.7);
      }
    });

    it("rejects verdict_calibration.confidence_min > 1.0", () => {
      const flow = {
        schemaVersion: 1,
        name: "test-flow",
        verdict_calibration: {
          confidence_min: 1.2,
        },
        nodes: [
          {
            id: "judge",
            type: "judge",
            action: { prompt: "test" },
          },
        ],
      };

      const parsed = flowYamlV1Schema.safeParse(flow);

      expect(parsed.success).toBe(false);
    });

    it("rejects verdict_calibration.confidence_min < 0", () => {
      const flow = {
        schemaVersion: 1,
        name: "test-flow",
        verdict_calibration: {
          confidence_min: -0.5,
        },
        nodes: [
          {
            id: "judge",
            type: "judge",
            action: { prompt: "test" },
          },
        ],
      };

      const parsed = flowYamlV1Schema.safeParse(flow);

      expect(parsed.success).toBe(false);
    });

    it("accepts a flow without verdict_calibration (optional)", () => {
      const flow = {
        schemaVersion: 1,
        name: "test-flow",
        nodes: [
          {
            id: "judge",
            type: "judge",
            action: { prompt: "test" },
          },
        ],
      };

      const parsed = flowYamlV1Schema.safeParse(flow);

      expect(parsed.success).toBe(true);
    });
  });
});
