import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeAdapterSmokeCache } from "../adapter-smoke-cache";

import {
  bootHost,
  cleanupRuntimeRoot,
  createEnvelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

// ADR-182 D-A1/D-A2 (RED S1): the host records the adapter's `initialize`
// steering advertisement per session and exposes it on the three surfaces the
// manager reads — the list entry, the create 201 body and the `session.created`
// event — plus the smoke-cache family evidence on `/diagnostics`.

let host: BootedHost | null = null;

afterEach(async () => {
  if (host) {
    await host.stop();
    await cleanupRuntimeRoot(host.runtimeRoot);
    host = null;
  }
});

async function createdEvent(booted: BootedHost, sessionId: string) {
  const events = booted.hostState.runtimeEventsAfter(
    booted.hostState.getRuntimeEventStreamId(),
    null,
  );

  return events
    .map((row) => row.envelope)
    .find(
      (envelope) =>
        envelope.eventType === "session.created" &&
        envelope.hostSessionId === sessionId,
    );
}

async function createOn(fixtureArgs: string[]) {
  host = await bootHost({ fixtureArgs: ["--hang", ...fixtureArgs] });
  const runId = `run-${randomUUID()}`;
  const res = await postJson(
    `${host.url}/sessions`,
    await createEnvelope(host, fenceFor(host, runId)),
  );

  expect(res.status).toBe(201);
  const list = await (await fetch(`${host.url}/sessions`)).json();
  const entry = (list as Array<Record<string, unknown>>).find(
    (session) => session.sessionId === res.body.sessionId,
  );

  return {
    created: res.body as Record<string, unknown>,
    entry,
    event: await createdEvent(host, res.body.sessionId as string),
  };
}

describe("steering capability (ADR-182)", () => {
  it("exposes an advertised capability on the list, the create body and session.created", async () => {
    const { created, entry, event } = await createOn(["--steering"]);

    expect(created.steeringSupported).toBe(true);
    expect(entry?.capabilities).toEqual({ steering: { supported: true } });
    expect(event?.payload).toMatchObject({ steeringSupported: true });
  });

  it("reports false on all three surfaces when the adapter does not advertise it", async () => {
    const { created, entry, event } = await createOn([]);

    expect(created.steeringSupported).toBe(false);
    expect(entry?.capabilities).toEqual({ steering: { supported: false } });
    expect(event?.payload).toMatchObject({ steeringSupported: false });
  });

  it("serves the smoke cache's steering evidence on /diagnostics, null when absent", async () => {
    host = await bootHost();
    await writeAdapterSmokeCache(
      join(host.runtimeRoot, "adapter-smoke-cache.json"),
      [
        {
          adapter: "claude",
          status: "ok",
          protocolVersion: 1,
          steering: { supported: true },
        },
        { adapter: "codex", status: "ok", protocolVersion: 1 },
      ],
    );
    const res = await fetch(`${host.url}/diagnostics`);
    const body = (await res.json()) as {
      adapters: Array<{
        id: string;
        smoke: {
          steering: { supported: boolean | null; checkedAt: string | null };
        };
      }>;
    };
    const smoke = (id: string) =>
      body.adapters.find((adapter) => adapter.id === id)?.smoke.steering;

    expect(res.status).toBe(200);
    expect(smoke("claude")?.supported).toBe(true);
    expect(smoke("claude")?.checkedAt).toEqual(expect.any(String));
    expect(smoke("codex")).toEqual({ supported: null, checkedAt: null });
    expect(smoke("gemini")).toEqual({ supported: null, checkedAt: null });
  });
});
