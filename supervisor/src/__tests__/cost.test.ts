import type { CostRecord } from "../cost";

import { describe, expect, it } from "vitest";

import {
  createTurnUsageRecorder,
  extractCost,
  extractCostWithSource,
} from "../cost";

describe("extractCost", () => {
  it("returns null for non-JSON line", () => {
    expect(extractCost("hello world", "s1")).toBeNull();
  });

  it("returns null for JSON without usage", () => {
    expect(
      extractCost(
        JSON.stringify({ type: "agent_message_chunk", text: "x" }),
        "s1",
      ),
    ).toBeNull();
  });

  it("extracts top-level usage", () => {
    const record = extractCost(
      JSON.stringify({
        type: "message_stop",
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
        },
      }),
      "s1",
    );

    expect(record).not.toBeNull();
    expect(record?.sessionId).toBe("s1");
    expect(record?.input_tokens).toBe(100);
    expect(record?.output_tokens).toBe(200);
    expect(record?.cache_creation_input_tokens).toBe(5000);
    expect(record?.cache_read_input_tokens).toBe(0);
    expect(typeof record?.ts).toBe("string");
  });

  it("extracts nested usage and model", () => {
    const record = extractCost(
      JSON.stringify({
        sessionUpdate: "agent_message_stop",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      }),
      "s2",
    );

    expect(record).not.toBeNull();
    expect(record?.model).toBe("claude-sonnet-4-6");
    expect(record?.input_tokens).toBe(10);
    expect(record?.output_tokens).toBe(20);
    expect(record?.cache_creation_input_tokens).toBeUndefined();
  });

  it("stamps run, step, and node-attempt attribution when context is provided", () => {
    const record = extractCost(
      JSON.stringify({
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      }),
      "s2",
      {
        sessionName: "review",
        projectSlug: "demo",
        runId: "run-1",
        stepId: "implement",
        nodeAttemptId: "node-attempt-1",
      },
    );

    expect(record).toMatchObject({
      sessionId: "s2",
      sessionName: "review",
      projectSlug: "demo",
      runId: "run-1",
      stepId: "implement",
      nodeAttemptId: "node-attempt-1",
      model: "claude-sonnet-4-6",
      input_tokens: 10,
      output_tokens: 20,
    });
  });

  it("extracts the camelCase end-turn result.usage shape (T-D2)", () => {
    const record = extractCost(
      JSON.stringify({
        result: {
          usage: {
            inputTokens: 100,
            outputTokens: 200,
            cachedWriteTokens: 5000,
            cachedReadTokens: 42,
          },
        },
      }),
      "s1",
    );

    expect(record).not.toBeNull();
    expect(record?.input_tokens).toBe(100);
    expect(record?.output_tokens).toBe(200);
    expect(record?.cache_creation_input_tokens).toBe(5000);
    expect(record?.cache_read_input_tokens).toBe(42);
  });

  it("does not double-count when a usage object carries both shapes (snake wins)", () => {
    const record = extractCost(
      JSON.stringify({
        usage: {
          input_tokens: 100,
          inputTokens: 999,
          output_tokens: 200,
          outputTokens: 999,
          cache_read_input_tokens: 7,
          cachedReadTokens: 999,
        },
      }),
      "s1",
    );

    expect(record?.input_tokens).toBe(100);
    expect(record?.output_tokens).toBe(200);
    expect(record?.cache_read_input_tokens).toBe(7);
  });

  it("returns null when usage object has no token fields", () => {
    const record = extractCost(
      JSON.stringify({ usage: { service_tier: "standard" } }),
      "s1",
    );

    expect(record).toBeNull();
  });

  it("ignores non-number token fields", () => {
    const record = extractCost(
      JSON.stringify({ usage: { input_tokens: "100" } }),
      "s1",
    );

    expect(record).toBeNull();
  });

  it("does not include a secret token-like substring in output", () => {
    const record = extractCost(
      JSON.stringify({
        usage: { input_tokens: 5 },
        api_key: "sk-test-redact",
        env: { ANTHROPIC_AUTH_TOKEN: "sk-test-redact" },
      }),
      "s1",
    );

    expect(record).not.toBeNull();
    const json = JSON.stringify(record);

    expect(json).not.toContain("sk-test-redact");
    expect(json).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("extractCostWithSource", () => {
  it("classifies the JSON-RPC end-turn result.usage as 'result' (canonical)", () => {
    const found = extractCostWithSource(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 55, outputTokens: 29870 },
        },
      }),
      "s1",
    );

    expect(found?.source).toBe("result");
    expect(found?.record.output_tokens).toBe(29870);
  });

  it("classifies a usage nested in a session/update notification as 'stream'", () => {
    // The real shape: a sub-agent's usage inside a Task tool response — already
    // subsumed by the turn's result.usage, so it must not be counted on top.
    const found = extractCostWithSource(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            _meta: {
              claudeCode: {
                toolResponse: {
                  usage: { input_tokens: 1, output_tokens: 1648 },
                },
              },
            },
          },
        },
      }),
      "s1",
    );

    expect(found?.source).toBe("stream");
    expect(found?.record.output_tokens).toBe(1648);
  });
});

describe("createTurnUsageRecorder", () => {
  function collect(): { emit: (r: CostRecord) => void; records: CostRecord[] } {
    const records: CostRecord[] = [];

    return { emit: (r) => records.push(r), records };
  }

  function rec(output: number): CostRecord {
    return { ts: "t", sessionId: "s1", output_tokens: output };
  }

  it("writes a result usage immediately and discards a same-turn stream usage", () => {
    const { emit, records } = collect();
    const recorder = createTurnUsageRecorder(emit);

    // A turn: a nested sub-agent usage (stream) then the end-turn total (result).
    recorder.offer(rec(1648), "stream");
    recorder.offer(rec(29870), "result");
    recorder.flush();

    // ONE record (the result total) — the stream usage is subsumed, not summed.
    expect(records.map((r) => r.output_tokens)).toEqual([29870]);
  });

  it("records exactly one result per turn across a multi-turn session (no double-count)", () => {
    const { emit, records } = collect();
    const recorder = createTurnUsageRecorder(emit);

    // Mirrors the real `plan` node: a nested snake usage + two end-turn results.
    recorder.offer(rec(1648), "stream");
    recorder.offer(rec(29870), "result");
    recorder.offer(rec(25630), "result");
    recorder.flush();

    expect(records.map((r) => r.output_tokens)).toEqual([29870, 25630]);
  });

  it("flushes a streaming-only turn at close so its spend is not lost", () => {
    const { emit, records } = collect();
    const recorder = createTurnUsageRecorder(emit);

    recorder.offer(rec(500), "stream");
    expect(records).toHaveLength(0); // buffered, not yet written
    recorder.flush();

    expect(records.map((r) => r.output_tokens)).toEqual([500]);
  });

  it("does not re-flush a stream usage already superseded by a result", () => {
    const { emit, records } = collect();
    const recorder = createTurnUsageRecorder(emit);

    recorder.offer(rec(500), "stream");
    recorder.offer(rec(900), "result");
    recorder.flush();

    expect(records.map((r) => r.output_tokens)).toEqual([900]);
  });
});
