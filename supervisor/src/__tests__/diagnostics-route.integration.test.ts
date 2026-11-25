// DIAG-02 / DIAG-05 / DIAG-07 wiring and DIAG-10 (ADR-224) — supervisor
// `GET /diagnostics` serves the snapshot policy through the real Fastify
// routes. The policy permutations are unit-proven in diagnostics-cache.test.ts;
// this file only proves the route is wired to it. Adapter overrides point at
// shim executables that count every `--version` probe they answer.
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { writeAdapterSmokeCache } from "../adapter-smoke-cache";

import { bootHost, type BootedHost } from "./_fixtures/boot-host";

const PROBED = ["GEMINI", "OPENCODE", "MIMO"] as const;

let host: BootedHost;
let shimDir: string;
let counterFile: string;
const previousEnv: Record<string, string | undefined> = {};

async function probeCount(): Promise<number> {
  const text = await readFile(counterFile, "utf8").catch(() => "");

  return text.split("\n").filter(Boolean).length;
}

beforeAll(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "diag-shim-"));
  counterFile = join(shimDir, "probes.log");
  for (const adapter of PROBED) {
    const envName = `MAISTER_ADAPTER_BINARY_${adapter}`;
    const shim = join(shimDir, adapter.toLowerCase());

    previousEnv[envName] = process.env[envName];
    await writeFile(
      shim,
      `#!/bin/sh\necho "${adapter}" >> "${counterFile}"\necho "${adapter.toLowerCase()} 9.9.9"\n`,
      "utf8",
    );
    await chmod(shim, 0o755);
    // Warm each shim once outside the 1 s version-probe budget: on macOS the
    // first execve of a newly written script can exceed 1 s under OS scanning,
    // while subsequent spawns finish in a few milliseconds.
    spawnSync(shim, ["--version"], { stdio: "ignore" });
    process.env[envName] = shim;
  }
});

afterAll(async () => {
  for (const adapter of PROBED) {
    const envName = `MAISTER_ADAPTER_BINARY_${adapter}`;
    const prev = previousEnv[envName];

    if (prev === undefined) delete process.env[envName];
    else process.env[envName] = prev;
  }
  await rm(shimDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(counterFile, { force: true });
  host = await bootHost();
});

afterEach(async () => {
  await host.stop();
});

describe("GET /diagnostics snapshot wiring", () => {
  it("DIAG-02 ten concurrent requests probe each adapter once and return one body", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => fetch(`${host.url}/diagnostics`)),
    );
    const bodies = await Promise.all(responses.map((res) => res.text()));

    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(await probeCount()).toBe(PROBED.length);
  });

  it("DIAG-05 refresh=1 probes the host again inside the TTL", async () => {
    await fetch(`${host.url}/diagnostics`);
    await fetch(`${host.url}/diagnostics`);
    expect(await probeCount()).toBe(PROBED.length);

    const forced = await fetch(`${host.url}/diagnostics?refresh=1`);

    expect(forced.status).toBe(200);
    expect(await probeCount()).toBe(PROBED.length * 2);
  });

  it("DIAG-07 a smoke-cache rewrite makes the next plain request probe again", async () => {
    await fetch(`${host.url}/diagnostics`);
    await fetch(`${host.url}/diagnostics`);
    expect(await probeCount()).toBe(PROBED.length);

    await writeAdapterSmokeCache(
      join(host.runtimeRoot, "adapter-smoke-cache.json"),
      [{ adapter: "gemini", status: "ok", protocolVersion: 1 }],
    );
    const res = await fetch(`${host.url}/diagnostics`);
    const body = (await res.json()) as {
      adapters: Array<{ id: string; smoke: { status: string } }>;
    };

    expect(await probeCount()).toBe(PROBED.length * 2);
    expect(body.adapters.find((a) => a.id === "gemini")?.smoke.status).toBe(
      "ok",
    );
  });

  it("DIAG-07 a smoke-cache stat failure other than a missing file is logged at WARN and treated as absent", async () => {
    await host.stop();
    const warnings: Record<string, unknown>[] = [];

    host = await bootHost({
      logger: pino(
        { level: "warn" },
        {
          write(line) {
            warnings.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      ),
    });
    expect((await fetch(`${host.url}/diagnostics`)).status).toBe(200);

    // A link that points at itself: stat() fails with ELOOP, which is not ENOENT
    // for root and non-root users alike.
    await symlink(
      "adapter-smoke-cache.json",
      join(host.runtimeRoot, "adapter-smoke-cache.json"),
    );

    expect((await fetch(`${host.url}/diagnostics`)).status).toBe(200);
    expect(warnings).toContainEqual(
      expect.objectContaining({ err: expect.stringContaining("ELOOP") }),
    );
  });

  it.each(["refresh=yes", "refresh=1&refresh=1", "refresh="])(
    "DIAG-10 %s answers 409 PRECONDITION and probes nothing",
    async (query) => {
      const res = await fetch(`${host.url}/diagnostics?${query}`);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "PRECONDITION",
        details: { reason: "diagnostics_query_invalid" },
      });
      expect(await probeCount()).toBe(0);
    },
  );
});
