import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { bootHost, type BootedHost } from "./_fixtures/boot-host";

// ADR-179: `POST /diagnostics/env-refs` is a PRESENCE oracle for host
// environment-variable names. Presence only — no value is returned, and the
// route logs a count, never a name.

const PRESENT = "MCP_ENV_REFS_PRESENT_SENTINEL";
const EMPTY = "MCP_ENV_REFS_EMPTY_SENTINEL";
const ABSENT = "MCP_ENV_REFS_ABSENT_SENTINEL";
const SECRET_VALUE = "value-1-do-not-echo";

type EnvRefsBody = { refs: Array<{ name: string; present: boolean }> };

let host: BootedHost;

async function ask(names: unknown): Promise<Response> {
  return fetch(`${host.url}/diagnostics/env-refs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ names }),
  });
}

beforeAll(async () => {
  process.env[PRESENT] = SECRET_VALUE;
  process.env[EMPTY] = "";
  delete process.env[ABSENT];

  host = await bootHost({ fixtureArgs: ["--hang"] });

  return async () => {
    delete process.env[PRESENT];
    delete process.env[EMPTY];
    await host.stop();
  };
});

afterEach(() => {
  delete process.env.MAISTER_DIAGNOSTIC_ENV_REFS;
});

describe("POST /diagnostics/env-refs", () => {
  it("reports presence per name and never the value", async () => {
    const res = await ask([PRESENT, EMPTY, ABSENT]);

    expect(res.status).toBe(200);

    const text = await res.text();

    // The whole point of the route: a presence oracle that leaks nothing.
    expect(text).not.toContain(SECRET_VALUE);

    expect(JSON.parse(text) as EnvRefsBody).toEqual({
      refs: [
        { name: PRESENT, present: true },
        // An empty string reads as ABSENT, matching `diagnosticEnvRefs()`.
        { name: EMPTY, present: false },
        { name: ABSENT, present: false },
      ],
    });
  });

  it("answers in REQUEST order after de-duplication, not sorted", async () => {
    const res = await ask([ABSENT, PRESENT, ABSENT]);
    const body = (await res.json()) as EnvRefsBody;

    expect(body.refs.map((r) => r.name)).toEqual([ABSENT, PRESENT]);
  });

  it("accepts 64 names and refuses 65 and 0", async () => {
    const names = (n: number) =>
      Array.from({ length: n }, (_, i) => `ENV_REFS_BOUND_${i}`);

    const at = await ask(names(64));

    expect(at.status).toBe(200);
    expect(((await at.json()) as EnvRefsBody).refs).toHaveLength(64);

    expect((await ask(names(65))).status).toBe(409);
    expect((await ask([])).status).toBe(409);
  });

  it("refuses a malformed name with PRECONDITION", async () => {
    for (const bad of ["BAD NAME", "1BAD", "a-b", ""]) {
      const res = await ask([bad]);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "PRECONDITION",
      );
    }
  });

  it("refuses a body that is not a name list", async () => {
    const res = await fetch(`${host.url}/diagnostics/env-refs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: [PRESENT], values: true }),
    });

    expect(res.status).toBe(409);
  });

  it("ignores MAISTER_DIAGNOSTIC_ENV_REFS — that list belongs to GET /diagnostics", async () => {
    process.env.MAISTER_DIAGNOSTIC_ENV_REFS = ABSENT;

    const body = (await (await ask([ABSENT])).json()) as EnvRefsBody;

    expect(body.refs).toEqual([{ name: ABSENT, present: false }]);
  });
});
