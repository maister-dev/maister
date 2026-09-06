import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  NODE_OUTPUT_TRANSPORT,
  cliOutputFilePath,
  extractSentinelBlock,
  readCliOutputFile,
  validateNodeStructuredOutput,
  type ValidateNodeStructuredOutputArgs,
} from "@/lib/flows/graph/node-output";
import {
  appendSentinelOutput,
  emptySentinelOutput,
  finishSentinelOutput,
} from "@/lib/flows/graph/node-output-stream";

const OPEN = "```json maister:output";
const CLOSE = "```";
const MAX = 262_144;

function block(content: string): string {
  return `${OPEN}\n${content}\n${CLOSE}`;
}

describe("streamed original node output", () => {
  it.each([
    "ordinary text",
    block('{"value":"a😀é"}'),
    `${block('{"first":true}')}\n${OPEN}\nunterminated`,
    `${block('{"first":true}')}\n${block("invalid json")}`,
    `${OPEN}\t\r\n{"value":1}\r\n${CLOSE} \t\r`,
    `${OPEN}\n${CLOSE}`,
    ` ${OPEN}\n{"not":"a block"}\n${CLOSE}`,
  ])("matches the existing parser at every chunk boundary: %s", (text) => {
    for (let boundary = 0; boundary <= text.length; boundary += 1) {
      const initial = emptySentinelOutput();
      const prefix = appendSentinelOutput(
        initial,
        text.slice(0, boundary),
        MAX,
      );
      const complete = appendSentinelOutput(prefix, text.slice(boundary), MAX);

      expect(finishSentinelOutput(complete, MAX)).toEqual(
        extractSentinelBlock(text, MAX),
      );
      expect(initial).toEqual(emptySentinelOutput());
    }
  });

  it("finds a tail result after megabytes of prose while retaining bounded state", () => {
    const prefix = appendSentinelOutput(
      emptySentinelOutput(),
      "x".repeat(2_000_000),
      64,
    );
    const complete = appendSentinelOutput(
      prefix,
      `\n${block('{"tail":true}')}`,
      64,
    );

    expect(prefix.line).toBeNull();
    expect(JSON.stringify(prefix).length).toBeLessThan(256);
    expect(finishSentinelOutput(complete, 64)).toEqual({
      kind: "value",
      value: { tail: true },
    });
  });

  it("rejects an oversized final payload instead of reusing the earlier success", () => {
    const text = `${block('{"pass":true}')}\n${block(`{"value":"${"x".repeat(1000)}"}`)}`;
    const result = finishSentinelOutput(
      appendSentinelOutput(emptySentinelOutput(), text, 64),
      64,
    );

    expect(result).toMatchObject({ kind: "invalid" });
  });

  it("enforces the exact UTF-8 payload limit across split surrogate pairs", () => {
    const text = block('{"value":"😀😀"}');
    let result = emptySentinelOutput();

    for (const char of text.split(""))
      result = appendSentinelOutput(result, char, 16);
    expect(finishSentinelOutput(result, 16)).toEqual(
      extractSentinelBlock(text, 16),
    );
    expect(finishSentinelOutput(result, 16)).toMatchObject({ kind: "invalid" });
  });

  it("recognizes long whitespace on a closing fence without retaining it", () => {
    const text = `${OPEN}\n{"value":1}\n${CLOSE}${" ".repeat(10_000)}\r`;

    expect(
      finishSentinelOutput(
        appendSentinelOutput(emptySentinelOutput(), text, 64),
        64,
      ),
    ).toEqual({ kind: "value", value: { value: 1 } });
  });
});

describe("extractSentinelBlock", () => {
  it("extracts a single properly-fenced block", () => {
    const out = `some prose\n${block('{"k":"v"}')}\n`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { k: "v" },
    });
  });

  it("matches a block embedded mid-prose", () => {
    const out = `intro text\nmore\n${block('{"a":1}')}\ntrailing prose`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { a: 1 },
    });
  });

  it("matches a block whose closing fence ends the capture (no trailing newline)", () => {
    const out = `prose\n${OPEN}\n{"end":true}\n${CLOSE}`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { end: true },
    });
  });

  it("last block wins when multiple blocks are present", () => {
    const out = `${block('{"k":"first"}')}\nmiddle prose\n${block('{"k":"second"}')}\n`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { k: "second" },
    });
  });

  it("does NOT match loose {verdict:...} JSON (no ai_judgment collision)", () => {
    const out =
      'Review done.\n{"verdict":"pass","confidence":0.9,"reasons":[]}\n';

    expect(extractSentinelBlock(out, MAX)).toEqual({ kind: "absent" });
  });

  it("does NOT match a plain ```json fence without the sentinel tag", () => {
    const out = '```json\n{"k":1}\n```\n';

    expect(extractSentinelBlock(out, MAX)).toEqual({ kind: "absent" });
  });

  it("returns absent when stdout has no block at all", () => {
    expect(extractSentinelBlock("just text", MAX)).toEqual({ kind: "absent" });
    expect(extractSentinelBlock("", MAX)).toEqual({ kind: "absent" });
  });

  it("accepts a payload of exactly maxBytes", () => {
    // {"k":"<pad>"} — wrapper is 8 bytes, ASCII only so bytes == chars.
    const pad = "a".repeat(MAX - 8);
    const out = block(`{"k":"${pad}"}`);
    const res = extractSentinelBlock(out, MAX);

    expect(res.kind).toBe("value");
    expect((res as { value: { k: string } }).value.k).toHaveLength(MAX - 8);
  });

  it("rejects a payload of maxBytes + 1 as invalid (oversize), before parse", () => {
    const pad = "a".repeat(MAX - 8 + 1);
    const out = block(`{"k":"${pad}"}`);
    const res = extractSentinelBlock(out, MAX);

    expect(res.kind).toBe("invalid");
    expect((res as { reason: string }).reason).toContain("exceeds");
  });

  it("treats an unterminated fence as absent", () => {
    const out = `prose\n${OPEN}\n{"k":1}\n`;

    expect(extractSentinelBlock(out, MAX)).toEqual({ kind: "absent" });
  });

  it("falls back to the last COMPLETE block when a trailing block is unterminated", () => {
    const out = `${block('{"k":"complete"}')}\n${OPEN}\n{"k":"cut`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { k: "complete" },
    });
  });

  it("flags an empty block as invalid (present but broken)", () => {
    const out = `${OPEN}\n${CLOSE}\n`;
    const res = extractSentinelBlock(out, MAX);

    expect(res.kind).toBe("invalid");
  });

  it("flags a whitespace-only block as invalid", () => {
    const out = `${OPEN}\n   \n${CLOSE}\n`;

    expect(extractSentinelBlock(out, MAX).kind).toBe("invalid");
  });

  it("flags non-JSON block content as invalid", () => {
    const out = block("not json at all");
    const res = extractSentinelBlock(out, MAX);

    expect(res.kind).toBe("invalid");
    expect((res as { reason: string }).reason).toContain("JSON");
  });

  it("tolerates CRLF line endings", () => {
    const out = `prose\r\n${OPEN}\r\n{"k":"crlf"}\r\n${CLOSE}\r\n`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { k: "crlf" },
    });
  });

  it("tolerates trailing whitespace after the opening fence tag", () => {
    const out = `${OPEN}  \n{"k":"ws"}\n${CLOSE}  \n`;

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { k: "ws" },
    });
  });

  it("strips a BOM at the start of block content", () => {
    const out = block('﻿{"k":"bom"}');

    expect(extractSentinelBlock(out, MAX)).toEqual({
      kind: "value",
      value: { k: "bom" },
    });
  });
});

describe("readCliOutputFile", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "node-output-cli-"));
  });

  it("returns absent for a missing file", async () => {
    expect(await readCliOutputFile(join(dir, "nope.json"), MAX)).toEqual({
      kind: "absent",
    });
  });

  it("returns the parsed value for a valid JSON file", async () => {
    const p = join(dir, "ok.json");

    await writeFile(p, '{"done":true,"count":2}', "utf8");
    expect(await readCliOutputFile(p, MAX)).toEqual({
      kind: "value",
      value: { done: true, count: 2 },
    });
  });

  it("flags invalid JSON as invalid with a reason", async () => {
    const p = join(dir, "bad.json");

    await writeFile(p, "{ nope", "utf8");
    const res = await readCliOutputFile(p, MAX);

    expect(res.kind).toBe("invalid");
    expect((res as { reason: string }).reason).toContain("JSON");
  });

  it("flags an oversize file as invalid before parsing", async () => {
    const p = join(dir, "big.json");
    // 65 bytes of valid JSON against a 64-byte cap.
    const body = `{"k":"${"a".repeat(57)}"}`;

    expect(Buffer.byteLength(body, "utf8")).toBe(65);
    await writeFile(p, body, "utf8");
    const res = await readCliOutputFile(p, 64);

    expect(res.kind).toBe("invalid");
    expect((res as { reason: string }).reason).toContain("exceeds");
  });

  it("accepts a file of exactly maxBytes", async () => {
    const p = join(dir, "exact.json");
    const body = `{"k":"${"a".repeat(56)}"}`;

    expect(Buffer.byteLength(body, "utf8")).toBe(64);
    await writeFile(p, body, "utf8");
    expect(await readCliOutputFile(p, 64)).toEqual({
      kind: "value",
      value: { k: "a".repeat(56) },
    });
  });

  it("strips a UTF-8 BOM before parsing", async () => {
    const p = join(dir, "bom.json");

    await writeFile(p, '﻿{"k":"bom"}', "utf8");
    expect(await readCliOutputFile(p, MAX)).toEqual({
      kind: "value",
      value: { k: "bom" },
    });
  });

  it("flags an empty file as invalid (present but broken)", async () => {
    const p = join(dir, "empty.json");

    await writeFile(p, "", "utf8");
    expect((await readCliOutputFile(p, MAX)).kind).toBe("invalid");
  });
});

describe("cliOutputFilePath", () => {
  it("builds the per-attempt path under the run dir", () => {
    expect(
      cliOutputFilePath({
        runtimeRoot: "/root",
        projectSlug: "demo",
        runId: "r1",
        nodeId: "build",
        attempt: 2,
      }),
    ).toBe("/root/.maister/demo/runs/r1/output-build-2.json");
  });

  it("accepts dotted, dashed, and underscored node ids", () => {
    expect(
      cliOutputFilePath({
        runtimeRoot: "/root",
        projectSlug: "demo",
        runId: "r1",
        nodeId: "build-step_1.v2",
        attempt: 1,
      }),
    ).toBe("/root/.maister/demo/runs/r1/output-build-step_1.v2-1.json");
  });

  it("throws CONFIG when the node id contains a path separator", () => {
    expect(() =>
      cliOutputFilePath({
        runtimeRoot: "/root",
        projectSlug: "demo",
        runId: "r1",
        nodeId: "x/../../secrets/y",
        attempt: 1,
      }),
    ).toThrowError(/not a valid filename segment/);
  });

  it("throws CONFIG when the node id contains a backslash", () => {
    expect(() =>
      cliOutputFilePath({
        runtimeRoot: "/root",
        projectSlug: "demo",
        runId: "r1",
        nodeId: "a\\b",
        attempt: 1,
      }),
    ).toThrowError(/not a valid filename segment/);
  });
});

// --- TB.4: the validate seam (mock ledger db) ---

type NodeAttemptUpdate = Record<string, unknown>;

function mockDb(): { updates: NodeAttemptUpdate[]; db: unknown } {
  const updates: NodeAttemptUpdate[] = [];

  return {
    updates,
    db: {
      update: () => ({
        set: (values: NodeAttemptUpdate) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
    },
  };
}

const SCHEMA_DOC = {
  schemaVersion: 1,
  fields: [
    { name: "verdict", type: "string", required: true },
    { name: "score", type: "number" },
  ],
};

const CONSENSUS_SCHEMA_DOC = {
  schemaVersion: 1,
  fields: [
    {
      name: "consensus",
      type: "object",
      required: true,
      fields: [
        { name: "source", type: "string", required: true },
        { name: "round", type: "number", required: true },
      ],
    },
  ],
};

describe("validateNodeStructuredOutput", () => {
  let flowInstallPath: string;
  let runtimeRoot: string;

  beforeAll(async () => {
    flowInstallPath = await mkdtemp(join(tmpdir(), "node-output-flow-"));
    runtimeRoot = await mkdtemp(join(tmpdir(), "node-output-rt-"));
    await mkdir(join(flowInstallPath, "schemas"), { recursive: true });
    await writeFile(
      join(flowInstallPath, "schemas", "result.json"),
      JSON.stringify(SCHEMA_DOC),
      "utf8",
    );
    await writeFile(
      join(flowInstallPath, "schemas", "consensus.json"),
      JSON.stringify(CONSENSUS_SCHEMA_DOC),
      "utf8",
    );
  });

  function seamArgs(overrides: {
    nodeType: ValidateNodeStructuredOutputArgs["node"]["nodeType"];
    output?: ValidateNodeStructuredOutputArgs["node"]["output"];
    stdout?: string;
    vars?: Record<string, unknown>;
    attempt?: number;
    db: unknown;
    runId?: string;
  }): ValidateNodeStructuredOutputArgs {
    return {
      node: {
        id: "n1",
        nodeType: overrides.nodeType,
        output: overrides.output,
      },
      result: {
        stdout: overrides.stdout ?? "",
        vars: overrides.vars ?? {},
      },
      attempt: overrides.attempt ?? 1,
      nodeAttemptId: "na-1",
      runId: overrides.runId ?? "r1",
      projectSlug: "demo",
      runtimeRoot,
      flowInstallPath,
      db: overrides.db as ValidateNodeStructuredOutputArgs["db"],
    };
  }

  const RESULT_DECL = { result: { schema: "./schemas/result.json" } };
  const REQUIRED_DECL = {
    result: { schema: "./schemas/result.json", required: true },
  };

  it("is a no-op when output.result is undefined (vars untouched, no db write)", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({ nodeType: "ai_coding", stdout: "anything", db });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toEqual({});
    expect(updates).toHaveLength(0);
  });

  it("is a no-op for a human node even when output.result is declared", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "human",
      output: RESULT_DECL,
      vars: { decision: "approve" },
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toEqual({ decision: "approve" });
    expect(updates).toHaveLength(0);
  });

  it("fails CONFIG (even when optional) for a cli node whose id escapes the run dir", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({ nodeType: "cli", output: RESULT_DECL, db });

    args.node = { ...args.node, id: "x/../../secrets/y" };

    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("not a valid filename segment");
  });

  it("is a no-op for a form node even when output.result is declared", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "form",
      output: RESULT_DECL,
      vars: { field: 1 },
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toEqual({ field: 1 });
    expect(updates).toHaveLength(0);
  });

  it("folds a valid ai_coding sentinel payload into result.vars", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: RESULT_DECL,
      stdout: `done.\n${OPEN}\n{"verdict":"pass","score":1}\n${CLOSE}\n`,
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toEqual({ verdict: "pass", score: 1 });
    expect(updates).toHaveLength(0);
  });

  it("folds a valid judge sentinel payload into result.vars", async () => {
    const { db } = mockDb();
    const args = seamArgs({
      nodeType: "judge",
      output: RESULT_DECL,
      stdout: `${OPEN}\n{"verdict":"fail"}\n${CLOSE}`,
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(true);
    expect(args.result.vars).toEqual({ verdict: "fail" });
  });

  it("reads a cli node's MAISTER_OUTPUT_FILE payload into result.vars", async () => {
    const { db } = mockDb();
    const file = cliOutputFilePath({
      runtimeRoot,
      projectSlug: "demo",
      runId: "r-cli",
      nodeId: "n1",
      attempt: 1,
    });

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"verdict":"pass","score":7}', "utf8");

    const args = seamArgs({
      nodeType: "cli",
      output: RESULT_DECL,
      runId: "r-cli",
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(true);
    expect(args.result.vars).toEqual({ verdict: "pass", score: 7 });
  });

  it("reads a check node's file via the same transport", async () => {
    const { db } = mockDb();
    const file = cliOutputFilePath({
      runtimeRoot,
      projectSlug: "demo",
      runId: "r-check",
      nodeId: "n1",
      attempt: 1,
    });

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"verdict":"ok"}', "utf8");

    const args = seamArgs({
      nodeType: "check",
      output: RESULT_DECL,
      runId: "r-check",
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(true);
    expect(args.result.vars).toEqual({ verdict: "ok" });
  });

  it("attempt N does not inherit attempt N-1's cli file (per-attempt isolation)", async () => {
    const { updates, db } = mockDb();
    const file = cliOutputFilePath({
      runtimeRoot,
      projectSlug: "demo",
      runId: "r-iso",
      nodeId: "n1",
      attempt: 1,
    });

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"verdict":"stale"}', "utf8");

    const args = seamArgs({
      nodeType: "cli",
      output: RESULT_DECL,
      runId: "r-iso",
      attempt: 2,
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(true);
    expect(args.result.vars).toEqual({});
    expect(updates).toHaveLength(0);
  });

  it("fails CONFIG when required and absent (sentinel)", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: REQUIRED_DECL,
      stdout: "no block here",
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("Failed");
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("[structured output]");
    expect(String(updates[0].stdout)).toContain("required but absent");
    expect(args.result.vars).toEqual({});
  });

  it("fails CONFIG when required and the cli file is absent", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "cli",
      output: REQUIRED_DECL,
      runId: "r-absent",
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].errorCode).toBe("CONFIG");
  });

  it("proceeds with vars {} when optional and absent", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: RESULT_DECL,
      stdout: "prose only",
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toEqual({});
    expect(updates).toHaveLength(0);
  });

  it("fails CONFIG on invalid JSON even when optional (spec-strict)", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: RESULT_DECL,
      stdout: `${OPEN}\nnot json\n${CLOSE}`,
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("JSON");
  });

  it("fails CONFIG on schema mismatch even when optional (spec-strict)", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: RESULT_DECL,
      stdout: `${OPEN}\n{"verdict":123}\n${CLOSE}`,
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("verdict");
    expect(args.result.vars).toEqual({});
  });

  it("fails CONFIG on an oversize payload even when optional (spec-strict)", async () => {
    const { updates, db } = mockDb();
    const pad = "a".repeat(262_144);
    const args = seamArgs({
      nodeType: "ai_coding",
      output: RESULT_DECL,
      stdout: `${OPEN}\n{"verdict":"${pad}"}\n${CLOSE}`,
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("exceeds");
  });

  // --- ADR-162 (AC-18): per-attempt contract identity ----------------------

  const SCHEMA_SHA256 = createHash("sha256")
    .update(new Uint8Array(Buffer.from(JSON.stringify(SCHEMA_DOC), "utf8")))
    .digest("hex");

  it("returns the resolved contract identity on success", async () => {
    const { db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: RESULT_DECL,
      stdout: `${OPEN}\n{"verdict":"pass"}\n${CLOSE}`,
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out).toEqual({
      ok: true,
      contract: {
        schemaRef: "./schemas/result.json",
        schemaVersion: 1,
        sha256: SCHEMA_SHA256,
        transport: "sentinel",
        engineVersion: "3.7.0",
      },
      // ADR-165: the seam also returns the PURE validated value. `result.vars`
      // is a merged bag (engine vars + this payload), so a caller that must
      // persist the value alone — the public-result publish — cannot recover it
      // from there.
      value: { verdict: "pass" },
      valueBytes: Buffer.byteLength('{"verdict":"pass"}', "utf8"),
    });
  });

  it("records the contract on the schema-mismatch failure path", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "cli",
      output: RESULT_DECL,
      runId: "r-contract-fail",
      db,
    });
    const file = cliOutputFilePath({
      runtimeRoot,
      projectSlug: "demo",
      runId: "r-contract-fail",
      nodeId: "n1",
      attempt: 1,
    });

    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"verdict":42}', "utf8");

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].outputContract).toEqual({
      schemaRef: "./schemas/result.json",
      schemaVersion: 1,
      sha256: SCHEMA_SHA256,
      transport: "file",
      engineVersion: "3.7.0",
    });
  });

  it("leaves the contract unset when the seam fails before the schema is read", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: REQUIRED_DECL,
      stdout: "no block",
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].outputContract).toBeUndefined();
  });

  it("carries the engine_vars transport in the contract for a consensus node", async () => {
    const { db } = mockDb();
    const args = seamArgs({
      nodeType: "consensus",
      output: { result: { schema: "./schemas/consensus.json" } },
      vars: { consensus: { source: "agreement", round: 1 } },
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok && out.contract?.transport).toBe("engine_vars");
    expect(out.ok && out.contract?.schemaRef).toBe("./schemas/consensus.json");
  });

  it("fails CONFIG when the declared schema path cannot be resolved", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "ai_coding",
      output: { result: { schema: "./schemas/missing.json" } },
      stdout: `${OPEN}\n{"verdict":"pass"}\n${CLOSE}`,
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("schema");
  });

  // --- ADR-162: orchestrator rides the sentinel transport (AC-7/AC-8) -------

  it("folds a valid orchestrator sentinel payload into result.vars", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "orchestrator",
      output: RESULT_DECL,
      stdout: `children settled.\n${OPEN}\n{"verdict":"pass","score":3}\n${CLOSE}\n`,
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toEqual({ verdict: "pass", score: 3 });
    expect(updates).toHaveLength(0);
  });

  it("fails an orchestrator with required output and no sentinel block, naming the block", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "orchestrator",
      output: REQUIRED_DECL,
      stdout: "all children finished, nothing emitted",
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("maister:output");
    expect(String(updates[0].stdout)).not.toContain("MAISTER_OUTPUT_FILE");
  });

  // --- ADR-162: consensus rides the engine_vars transport (AC-10) -----------

  const CONSENSUS_DECL = { result: { schema: "./schemas/consensus.json" } };
  const CONSENSUS_REQUIRED_DECL = {
    result: { schema: "./schemas/consensus.json", required: true },
  };

  it("validates a consensus node's engine vars WITHOUT mutating them", async () => {
    const { updates, db } = mockDb();
    const vars = {
      consensus: {
        source: "agreement",
        round: 2,
        consensusPlanArtifactId: "consensus_plan",
      },
    };
    const args = seamArgs({
      nodeType: "consensus",
      output: CONSENSUS_DECL,
      vars,
      db,
    });
    const out = await validateNodeStructuredOutput(args);

    expect(out.ok).toBe(true);
    expect(args.result.vars).toBe(vars);
    expect(args.result.vars).toEqual({
      consensus: {
        source: "agreement",
        round: 2,
        consensusPlanArtifactId: "consensus_plan",
      },
    });
    expect(updates).toHaveLength(0);
  });

  it("fails a consensus node whose engine vars mismatch the schema", async () => {
    const { updates, db } = mockDb();
    const args = seamArgs({
      nodeType: "consensus",
      output: CONSENSUS_DECL,
      vars: { consensus: { source: "agreement", round: "two" } },
      db,
    });

    expect((await validateNodeStructuredOutput(args)).ok).toBe(false);
    expect(updates[0].errorCode).toBe("CONFIG");
    expect(String(updates[0].stdout)).toContain("schema mismatch");
  });

  it("treats zero-key consensus vars as absent: required fails, optional passes", async () => {
    const required = mockDb();
    const requiredArgs = seamArgs({
      nodeType: "consensus",
      output: CONSENSUS_REQUIRED_DECL,
      vars: {},
      db: required.db,
    });

    expect((await validateNodeStructuredOutput(requiredArgs)).ok).toBe(false);
    expect(required.updates[0].errorCode).toBe("CONFIG");
    expect(String(required.updates[0].stdout)).toContain("engine vars");

    const optional = mockDb();
    const optionalArgs = seamArgs({
      nodeType: "consensus",
      output: CONSENSUS_DECL,
      vars: {},
      db: optional.db,
    });

    expect((await validateNodeStructuredOutput(optionalArgs)).ok).toBe(true);
    expect(optionalArgs.result.vars).toEqual({});
    expect(optional.updates).toHaveLength(0);
  });
});

// --- ADR-162 (Wave 3): transport matrix -------------------------------------

describe("NODE_OUTPUT_TRANSPORT (AC-14)", () => {
  it("covers every node type exactly once with the locked mapping", () => {
    expect(NODE_OUTPUT_TRANSPORT).toEqual({
      ai_coding: "sentinel",
      judge: "sentinel",
      orchestrator: "sentinel",
      cli: "file",
      check: "file",
      consensus: "engine_vars",
      human: null,
      form: null,
    });
  });
});
