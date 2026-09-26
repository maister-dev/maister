import type { BoundedPrunerPass, RuntimeEventPruneMode } from "../host-state";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { startBoundedPruner } from "../host-state";

const silent = pino({ level: "silent" });

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await drain();
}

type Harness = {
  pages: RuntimeEventPruneMode[];
  passes: BoundedPrunerPass[];
  rows: { value: number };
  kick: (mode: RuntimeEventPruneMode) => void;
  stop: () => void;
};

const stops: Array<() => void> = [];

afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
});

// A fake store: each page removes up to 3 of `rows`; retained-pressure passes
// continue while more than `low` rows remain.
function harness(opts: { rows: number; low: number }): Harness {
  const pages: RuntimeEventPruneMode[] = [];
  const passes: BoundedPrunerPass[] = [];
  const rows = { value: opts.rows };
  let kickFromPage: ((mode: RuntimeEventPruneMode) => void) | null = null;
  const pruner = startBoundedPruner({
    prunePage: (mode) => {
      pages.push(mode);
      const pruned = Math.min(3, rows.value);

      rows.value -= pruned;
      // A page's own commit notifies capacity; the pruner must ignore it.
      kickFromPage?.("retained_pressure");

      return pruned;
    },
    continuePass: (mode) => mode === "grace" || rows.value > opts.low,
    onPassEnd: (pass) => passes.push(pass),
    available: () => true,
    reportFailure: () => {},
    logger: silent,
    message: "test-pruned",
    intervalMs: 60 * 60 * 1000,
  });

  kickFromPage = pruner.kick;
  stops.push(pruner.stop);

  return { pages, passes, rows, kick: pruner.kick, stop: pruner.stop };
}

describe("startBoundedPruner (ADR-183 D3)", () => {
  it("runs the boot grace page synchronously and ends the pass on an empty page", async () => {
    const h = harness({ rows: 0, low: 0 });

    expect(h.pages).toEqual(["grace"]);
    await settle();
    expect(h.passes).toEqual([{ mode: "grace", pruned: 0, pages: 0 }]);
  });

  it("stops a retained-pressure pass at its target instead of pruning everything", async () => {
    const h = harness({ rows: 0, low: 5 });

    await settle();
    h.rows.value = 20;
    h.kick("retained_pressure");
    await settle();
    // 20 → 17 → … → 5: the page that reaches 5 ends the pass (continuePass).
    expect(h.rows.value).toBe(5);
    expect(h.passes.at(-1)).toEqual({
      mode: "retained_pressure",
      pruned: 15,
      pages: 5,
    });
  });

  it("coalesces kicks during a pass into one follow-up pass, retained pressure winning", async () => {
    const h = harness({ rows: 0, low: 0 });

    await settle();
    h.rows.value = 9;
    h.kick("grace");
    h.kick("grace");
    h.kick("retained_pressure");
    h.kick("grace");
    await settle();
    const modes = h.passes.slice(1).map((pass) => pass.mode);

    expect(modes).toEqual(["grace", "retained_pressure"]);
    // The follow-up pass found nothing left; the page's own kick never looped.
    expect(h.passes.at(-1)).toEqual({
      mode: "retained_pressure",
      pruned: 0,
      pages: 0,
    });
  });

  it("does nothing after stop", async () => {
    const h = harness({ rows: 0, low: 0 });

    await settle();
    h.stop();
    h.rows.value = 9;
    h.kick("retained_pressure");
    await settle();
    expect(h.rows.value).toBe(9);
  });
});
