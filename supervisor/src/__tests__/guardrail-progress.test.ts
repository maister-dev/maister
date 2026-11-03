import { describe, expect, it } from "vitest";

import {
  accountProgress,
  finishProgressTurn,
  initialProgressState,
  type ProgressState,
} from "../guardrail-progress";

type Update = Record<string, unknown>;
const start = (id: string, kind = "execute"): Update => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  status: "pending",
  kind,
  rawInput: { command: "check" },
});
const finish = (
  id: string,
  status = "completed",
  result?: unknown,
): Update => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status,
  ...(result === undefined ? {} : { rawOutput: result }),
});

function replay(
  updates: Update[],
  threshold = 3,
): ReturnType<typeof accountProgress> {
  return updates.reduce<ReturnType<typeof accountProgress>>(
    (previous, update) => accountProgress(previous.state, update, threshold),
    { state: initialProgressState(), tripped: false },
  );
}

describe("completed-work no_progress accounting", () => {
  it("does not count pending, in-progress, duplicate starts, or streamed chunks", () => {
    const result = replay([
      start("a"),
      start("a"),
      { ...start("a"), status: "in_progress" },
      { sessionUpdate: "agent_message_chunk" },
    ]);

    expect(result.state.countedOperations).toBe(0);
    expect(result.state.pending.size).toBe(1);
    expect(result.tripped).toBe(false);
  });

  it("counts sparse completion once using announcement metadata and ignores duplicate terminal updates", () => {
    const result = replay([
      start("a", "read"),
      finish("a", "completed", "source code"),
      finish("a", "failed"),
      start("a"),
    ]);

    expect(result.state).toMatchObject({
      countedOperations: 1,
      progressResets: 1,
      turnsSinceProgress: 0,
      ignoredUpdates: 2,
    });
    expect(result.state.pending.size).toBe(0);
  });

  it.each(["read", "search", "fetch", "other", "think"])(
    "allows useful %s work with new results for read-only and investigation phases",
    (kind) => {
      const updates = Array.from({ length: 30 }, (_, i) => [
        {
          ...start(`r${i}`, kind),
          rawInput: { file_path: `src/module${i}.ts` },
        },
        finish(`r${i}`, "completed", `new finding ${i}`),
      ]).flat();
      const result = replay(updates);

      expect(result.state).toMatchObject({
        countedOperations: 30,
        progressResets: 30,
        turnsSinceProgress: 0,
      });
      expect(result.tripped).toBe(false);
    },
  );

  it("bounds repetitive work even with distinct IDs, changing display titles and different commands", () => {
    const result = replay(
      Array.from({ length: 4 }, (_, i) => [
        {
          ...start(`r${i}`),
          title: `Step ${i}`,
          rawInput: { command: `check ${i}` },
        },
        finish(`r${i}`, "completed", "unchanged result"),
      ]).flat(),
    );

    expect(result.state).toMatchObject({
      countedOperations: 4,
      progressResets: 1,
      turnsSinceProgress: 3,
    });
    expect(result.tripped).toBe(true);
  });

  it("does not credit a write start, failed write, or repeated successful write request", () => {
    const result = replay([
      start("a", "edit"),
      finish("a", "failed"),
      start("b", "edit"),
      finish("b"),
      start("c", "edit"),
      finish("c"),
    ]);

    expect(result.state).toMatchObject({
      countedOperations: 3,
      progressResets: 1,
      turnsSinceProgress: 1,
    });
  });

  it("does not credit repeated execute requests with changing timestamps", () => {
    const result = replay(
      Array.from({ length: 4 }, (_, i) => [
        start(`r${i}`),
        finish(`r${i}`, "completed", { timestamp: i }),
      ]).flat(),
    );

    expect(result.state).toMatchObject({
      progressResets: 1,
      turnsSinceProgress: 3,
    });
    expect(result.tripped).toBe(true);
  });

  it("counts failures and missing evidence without treating reads or executes as automatic progress", () => {
    const result = replay([
      start("a", "read"),
      finish("a"),
      start("b"),
      finish("b", "failed", "new error"),
      finish("c"),
    ]);

    expect(result.state).toMatchObject({
      countedOperations: 3,
      progressResets: 0,
      turnsSinceProgress: 3,
    });
    expect(result.tripped).toBe(true);
  });

  it("waits for a known parallel useful completion rather than halting on failures that finish first", () => {
    const before = replay([
      start("useful", "search"),
      start("bad"),
      finish("bad", "failed"),
      finish("bad2", "failed"),
      finish("bad3", "failed"),
    ]);

    expect(before.state.turnsSinceProgress).toBe(3);
    expect(before.tripped).toBe(false);
    const after = accountProgress(
      before.state,
      finish("useful", "completed", "useful evidence"),
      3,
    );

    expect(after.tripped).toBe(false);
    expect(after.state.turnsSinceProgress).toBe(0);
  });

  it("counts unsolicited cancellation and halts when the parallel cohort settles", () => {
    const before = replay([
      start("cancelled"),
      finish("a", "failed"),
      finish("b", "failed"),
      finish("c", "failed"),
    ]);
    const after = accountProgress(
      before.state,
      finish("cancelled", "cancelled"),
      3,
    );

    expect(after.state.countedOperations).toBe(4);
    expect(after.state.pending.size).toBe(0);
    expect(after.tripped).toBe(true);
  });

  it("deduplicates a definitive denial followed by a failed adapter completion", () => {
    const result = replay([
      start("deny", "edit"),
      { ...finish("deny", "failed"), kind: "edit" },
      finish("deny", "failed"),
    ]);

    expect(result.state).toMatchObject({
      countedOperations: 1,
      turnsSinceProgress: 1,
      progressResets: 0,
    });
  });

  it("does not invent work IDs from incomplete metadata", () => {
    const result = replay(
      Array.from({ length: 20 }, () => ({
        sessionUpdate: "tool_call_update",
        status: "completed",
      })),
    );

    expect(result.state).toMatchObject({
      countedOperations: 0,
      ignoredUpdates: 20,
    });
    expect(result.tripped).toBe(false);
  });

  it("canonicalizes object keys so reordered identical results cannot reset the budget", () => {
    const result = replay([
      {
        ...finish("a", "completed", { a: 1, b: 2 }),
        kind: "read",
        rawInput: { path: "a" },
      },
      {
        ...finish("b", "completed", { b: 2, a: 1 }),
        kind: "read",
        rawInput: { path: "b" },
      },
    ]);

    expect(result.state).toMatchObject({
      progressResets: 1,
      turnsSinceProgress: 1,
    });
  });

  it("bounds a rolling parallel window with a permanently pending tool", () => {
    let state = replay([start("sentinel")]).state;

    for (let i = 1; i <= 6; i += 1) {
      const result = accountProgress(state, finish(`bad${i}`, "failed"), 3);

      expect(result.tripped).toBe(i === 6);
      state = result.state;
    }
  });

  it("bounds repeated cancellations without stop intent", () => {
    const result = replay([
      finish("a", "cancelled"),
      finish("b", "cancelled"),
      finish("c", "cancelled"),
    ]);

    expect(result.state.countedOperations).toBe(3);
    expect(result.tripped).toBe(true);
  });

  it("does not credit repeated reads of the same resource with volatile output", () => {
    const result = replay(
      Array.from({ length: 4 }, (_, i) => [
        start(`r${i}`, "read"),
        finish(`r${i}`, "completed", { timestamp: i }),
      ]).flat(),
    );

    expect(result.state).toMatchObject({
      progressResets: 1,
      turnsSinceProgress: 3,
    });
    expect(result.tripped).toBe(true);
  });

  it("closes intentionally cancelled pending work without counting its late failed completion", () => {
    const before = replay([start("cancelled")]);
    const state = finishProgressTurn(before.state);
    const after = accountProgress(state, finish("cancelled", "failed"), 3);

    expect(after.state.pending.size).toBe(0);
    expect(after.state.countedOperations).toBe(0);
    expect(after.tripped).toBe(false);
  });

  it("bounds a genuine loop at the requested default of 150 settled operations", () => {
    let state: ProgressState = initialProgressState();

    for (let i = 1; i <= 150; i += 1) {
      const result = accountProgress(state, finish(`f${i}`, "failed"), 150);

      expect(result.tripped).toBe(i === 150);
      state = result.state;
    }
    expect(state.countedOperations).toBe(150);
  });
});
