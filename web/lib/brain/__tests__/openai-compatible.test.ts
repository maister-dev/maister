import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  embeddingVersion,
  makeEmbeddingClient,
  type EmbeddingClientConfig,
} from "@/lib/brain/openai-compatible";
import { isMaisterError } from "@/lib/errors";

// T2.1 — the OpenAI-compatible embed/complete client. All network is a mocked
// injected fetch; no real provider is contacted. retryDelayMs=0 keeps retries
// instant.

const SECRET = "sk-super-secret-DO-NOT-LEAK-42";

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A fetch that dispenses queued responses (or a factory) and records each call.
function mockFetch(
  responses: Array<
    Response | (() => Response | Promise<Response>) | "network-error"
  >,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];

    i++;

    if (r === "network-error") throw new Error("boom (network)");

    return typeof r === "function" ? await r() : r;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function cfg(over: Partial<EmbeddingClientConfig> = {}): EmbeddingClientConfig {
  return {
    baseUrl: "https://api.example.test/v1",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    apiKeyRef: "env:TEST_EMB_KEY",
    distillModel: "distiller-x",
    maxRetries: 2,
    retryDelayMs: 0,
    ...over,
  };
}

describe("openai-compatible client (T2.1)", () => {
  beforeEach(() => {
    process.env.TEST_EMB_KEY = SECRET;
  });

  afterEach(() => {
    delete process.env.TEST_EMB_KEY;
  });

  it("embed returns the provider vectors and sends the model + input", async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ data: [{ embedding: [1, 2, 3, 4] }] }),
    ]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    const out = await client.embed(["hello"]);

    expect(out).toEqual([[1, 2, 3, 4]]);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/embeddings");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "text-embedding-3-small",
      input: ["hello"],
    });
  });

  it("embed([]) short-circuits without a request", async () => {
    const { fetchImpl, calls } = mockFetch([jsonResponse({ data: [] })]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    expect(await client.embed([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("retries a transient 5xx then succeeds", async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ error: "upstream" }, 503),
      jsonResponse({ data: [{ embedding: [0, 0, 0, 1] }] }),
    ]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    const out = await client.embed(["x"]);

    expect(out).toEqual([[0, 0, 0, 1]]);
    expect(calls).toHaveLength(2);
  });

  it("throws EMBEDDING_UNAVAILABLE after retries are exhausted (2 retries = 3 attempts)", async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ error: "down" }, 500),
    ]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    let thrown: unknown;

    try {
      await client.embed(["x"]);
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown) && thrown.code).toBe("EMBEDDING_UNAVAILABLE");
    expect(calls).toHaveLength(3);
  });

  it("retries a network error then throws EMBEDDING_UNAVAILABLE", async () => {
    const { fetchImpl, calls } = mockFetch(["network-error"]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    await expect(client.embed(["x"])).rejects.toMatchObject({
      code: "EMBEDDING_UNAVAILABLE",
    });
    expect(calls).toHaveLength(3);
  });

  it("uses the env:NAME key in the Authorization header but NEVER leaks it in logs/errors", async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ error: "down" }, 500),
    ]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);

    (process.stdout as any).write = (c: unknown) => {
      chunks.push(String(c));

      return true;
    };

    let thrown: unknown;

    try {
      await client.embed(["x"]);
    } catch (err) {
      thrown = err;
    } finally {
      (process.stdout as unknown as { write: unknown }).write = orig;
    }

    // the key WAS used (the test is meaningful) ...
    expect(
      (calls[0]?.init.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${SECRET}`);
    // ... but never leaks into the thrown message ...
    const err = thrown as Error;

    expect(err.message).not.toContain(SECRET);
    expect(String(err.stack ?? "")).not.toContain(SECRET);
    // ... nor into anything written to stdout (the redacted warns).
    expect(chunks.join("")).not.toContain(SECRET);
  });

  it("maps a returned-vector dimension mismatch to CONFIG (not a retryable outage)", async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ data: [{ embedding: [1, 2, 3] }] }), // 3 ≠ configured 4
    ]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    await expect(client.embed(["x"])).rejects.toMatchObject({ code: "CONFIG" });
    expect(calls).toHaveLength(1); // a 200 body is not retried
  });

  it("complete returns the assistant content", async () => {
    const { fetchImpl, calls } = mockFetch([
      jsonResponse({ choices: [{ message: { content: "a lesson" } }] }),
    ]);
    const client = makeEmbeddingClient(cfg({ fetchImpl }));

    expect(await client.complete("prompt")).toBe("a lesson");
    expect(calls[0]?.url).toBe("https://api.example.test/v1/chat/completions");
  });

  it("complete without distill_model throws CONFIG before any request", async () => {
    const { fetchImpl, calls } = mockFetch([jsonResponse({})]);
    const client = makeEmbeddingClient(cfg({ fetchImpl, distillModel: null }));

    await expect(client.complete("p")).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(calls).toHaveLength(0);
  });

  it("embeddingVersion changes when model OR dimensions change", () => {
    expect(embeddingVersion("m", 1536)).toBe("m@1536");
    expect(embeddingVersion("m", 768)).not.toBe(embeddingVersion("m", 1536));
    expect(embeddingVersion("n", 1536)).not.toBe(embeddingVersion("m", 1536));
  });
});
