import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkSupervisorDiagnostics } from "@/lib/supervisor-client";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
  type RealSupervisor,
} from "@/test-support/real-supervisor";

// ADR-182 T1.0 (C28): the web decodes `/diagnostics` with a strict schema, so a
// field the supervisor adds is a wire change across two deploy units. This pin
// feeds the REAL supervisor's answer — with `smoke.steering` present — through
// the web decoder; a unit fixture alone cannot prove the two agree.

let supervisor: RealSupervisor;
let restoreUrl: () => void = () => {};
let cacheDir: string;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "steering-wire-"));
  const cachePath = join(cacheDir, "adapter-smoke-cache.json");

  await writeFile(
    cachePath,
    JSON.stringify({
      version: 2,
      adapters: {
        claude: {
          status: "ok",
          checkedAt: "2026-09-25T10:00:00.000Z",
          protocolVersion: 1,
          steering: { supported: true, checkedAt: "2026-09-25T10:00:00.000Z" },
        },
      },
    }),
  );
  supervisor = await startRealSupervisor({
    env: { MAISTER_ADAPTER_SMOKE_CACHE_PATH: cachePath },
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
}, 180_000);

afterAll(async () => {
  restoreUrl();
  await supervisor?.kill();
  await rm(cacheDir, { recursive: true, force: true });
});

describe("supervisor /diagnostics steering evidence on the wire (ADR-182)", () => {
  it("parses the real host's smoke.steering through the strict web decoder", async () => {
    const status = await checkSupervisorDiagnostics();

    expect(status.kind).toBe("ready");
    if (status.kind !== "ready") return;
    const steering = (id: string) =>
      status.diagnostics.adapters.find((adapter) => adapter.id === id)?.smoke
        .steering;

    expect(steering("claude")).toEqual({
      supported: true,
      checkedAt: "2026-09-25T10:00:00.000Z",
    });
    expect(steering("codex")).toEqual({ supported: null, checkedAt: null });
  });
});
