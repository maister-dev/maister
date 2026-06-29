import { describe, expect, it } from "vitest";

import enMessages from "@/messages/en.json";
import ruMessages from "@/messages/ru.json";
import {
  NODE_STATUS_KEYS,
  NODE_STATUS_TONE_CLASS,
  nodeStatusVisual,
  type NodeStatusKey,
  type NodeStatusTone,
} from "@/lib/runs/node-status-visual";

// Phase A (run-detail transparency): the node-status → visual mapping is the
// SSOT for the three run-detail render sites (Ноды list, canvas chip, selected
// «СТАТУС» field). A table over every node_attempts.status value keeps the
// mapping honest and proves the tone-class Record covers every produced tone.
const EXPECTED_TONE: Record<NodeStatusKey, NodeStatusTone> = {
  Pending: "pending",
  Running: "running",
  Succeeded: "done",
  Failed: "failed",
  NeedsInput: "needs",
  Reworked: "rework",
  Stale: "stale",
  Skipped: "skipped",
};

describe("nodeStatusVisual", () => {
  it.each(NODE_STATUS_KEYS)(
    "maps %s to a distinct, fully-defined visual",
    (status) => {
      const visual = nodeStatusVisual(status);

      expect(visual.iconName).toBeTruthy();
      expect(visual.tone).toBe(EXPECTED_TONE[status]);
      expect(visual.i18nKey).toBe(`run.nodeStatus.${status}`);
    },
  );

  it("assigns a distinct icon to every known status", () => {
    const icons = NODE_STATUS_KEYS.map((s) => nodeStatusVisual(s).iconName);

    expect(new Set(icons).size).toBe(NODE_STATUS_KEYS.length);
  });

  it("falls back to a neutral visual for an unknown status (never throws)", () => {
    const visual = nodeStatusVisual("Bogus");

    expect(visual.tone).toBe("pending");
    expect(visual.iconName).toBeTruthy();
    expect(() => nodeStatusVisual("")).not.toThrow();
  });

  it("the tone-class map covers every tone produced by the mapping", () => {
    const tones = new Set<NodeStatusTone>(
      NODE_STATUS_KEYS.map((s) => nodeStatusVisual(s).tone),
    );

    for (const tone of tones) {
      expect(NODE_STATUS_TONE_CLASS[tone]).toBeTruthy();
    }
  });

  it("every status has an EN + RU label at parity (key set ⊆ catalog)", () => {
    const en = (enMessages as { run: { nodeStatus?: Record<string, string> } })
      .run.nodeStatus;
    const ru = (ruMessages as { run: { nodeStatus?: Record<string, string> } })
      .run.nodeStatus;

    expect(en).toBeDefined();
    expect(ru).toBeDefined();

    for (const status of NODE_STATUS_KEYS) {
      expect(en?.[status]).toBeTruthy();
      expect(ru?.[status]).toBeTruthy();
    }
  });
});
