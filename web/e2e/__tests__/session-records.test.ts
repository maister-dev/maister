import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { readStubSessionRecords } from "../_seed/session-records";

it("reads canonical supervisor session records separately from typed diagnostic sidecars", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stub-session-records-"));
  const sessionId = randomUUID();
  const commandId = randomUUID();
  const record = {
    sessionId,
    acpSessionId: randomUUID(),
    request: { runId: randomUUID(), readOnlySession: true },
    prompts: [{ prompt: "Controlled provider request" }],
  };

  try {
    await writeFile(
      path.join(directory, `${sessionId}.json`),
      JSON.stringify(record),
    );
    await writeFile(
      path.join(directory, `${sessionId}.${commandId}.recursive-turn.json`),
      JSON.stringify({
        version: 1,
        sessionId,
        commandId,
        sentinelPresent: false,
      }),
    );

    expect(readStubSessionRecords(directory)).toEqual([record]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses malformed canonical session records without exposing private file contents", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stub-session-records-"));
  const sessionId = randomUUID();

  try {
    await writeFile(
      path.join(directory, `${sessionId}.json`),
      JSON.stringify({ sessionId, privatePrompt: "private-record-sentinel" }),
    );

    expect(() => readStubSessionRecords(directory)).toThrow(
      `Invalid controlled supervisor session record: ${sessionId}.json`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses a canonical filename whose stored session identity differs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "stub-session-records-"));
  const filenameId = randomUUID();

  try {
    await writeFile(
      path.join(directory, `${filenameId}.json`),
      JSON.stringify({
        sessionId: randomUUID(),
        acpSessionId: randomUUID(),
        request: { runId: randomUUID() },
        prompts: [],
      }),
    );

    expect(() => readStubSessionRecords(directory)).toThrow(
      `Invalid controlled supervisor session record: ${filenameId}.json`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
