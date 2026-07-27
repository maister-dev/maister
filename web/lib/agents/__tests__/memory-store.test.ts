import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeRootMock = vi.hoisted(() => ({ value: "/tmp/unset" }));

vi.mock("@/lib/runtime-root", () => ({
  runtimeRoot: () => runtimeRootMock.value,
}));

import {
  agentMemoryPath,
  hashAgentMemory,
  readAgentMemory,
  writeAgentMemory,
} from "@/lib/agents/memory-store";
import { agentMemoryMaxChars } from "@/lib/instance-config";
import { isMaisterError } from "@/lib/errors-core";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "maister-memstore-"));
  runtimeRootMock.value = root;
  delete process.env.MAISTER_AGENT_MEMORY_MAX_CHARS;
});

afterEach(async () => {
  delete process.env.MAISTER_AGENT_MEMORY_MAX_CHARS;
  await rm(root, { force: true, recursive: true });
});

function expectConfig(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected CONFIG");
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    if (isMaisterError(err)) expect(err.code).toBe("CONFIG");
  }
}

describe("T-C3 / REQ-C3 — agentMemoryPath is injective and confined", () => {
  // REQ-C3 AC3. Each row is a PAIR of distinct qualified ids that a naive
  // `id.split(":").join("/")` (or any encoder that leaves `/` intact) would map
  // to the SAME file. Per-component encoding makes the collision impossible, not
  // merely improbable — which is the whole argument in ADR-152 D10.
  const COLLISION_PAIRS: Array<[string, string, string]> = [
    ["a slash in the stem vs a deeper package", "a:b/c", "a/b:c"],
    ["separator smuggled into a component", "a:b:c", "a:b%3Ac"],
    ["percent already present", "a:b%2Fc", "a:b/c"],
    ["dot-dot escape vs a literal name", "a:..", "a:%2E%2E"],
    ["whitespace vs encoded whitespace", "a:b c", "a:b%20c"],
    ["unicode vs its escape", "a:π", "a:%CF%80"],
    ["trailing separator", "a:b/", "a:b%2F"],
  ];

  it.each(COLLISION_PAIRS)(
    "REQ-C3 AC3 — %s: `%s` and `%s` never share a path",
    (_label, left, right) => {
      const paths = [left, right].map((id) => {
        try {
          return agentMemoryPath("proj", id);
        } catch {
          // A refusal is a perfectly good way to avoid a collision — what must
          // never happen is two ACCEPTED ids landing on one file.
          return `refused:${id}`;
        }
      });

      expect(paths[0]).not.toBe(paths[1]);
    },
  );

  it("REQ-C3 AC1 — splits on the id's FIRST colon, so a stem may contain further colons", () => {
    const derived = agentMemoryPath("proj", "core:sub:agent");

    expect(derived).toContain(path.join("agents", "core"));
    expect(path.basename(derived)).toBe("memory.md");
  });

  it("REQ-C3 AC2 — keeps a safe component verbatim and percent-encodes everything else in UPPERCASE hex", () => {
    expect(agentMemoryPath("proj", "core-1.x_y:keeper")).toContain(
      path.join("agents", "core-1.x_y", "keeper"),
    );
    expect(agentMemoryPath("proj", "a:b c")).toContain("b%20c");
    expect(agentMemoryPath("proj", "a:b/c")).toContain("b%2Fc");
  });

  it("REQ-C3 AC2 — refuses a component that encodes to `.` or `..`", () => {
    expectConfig(() => agentMemoryPath("proj", "a:."));
    expectConfig(() => agentMemoryPath("proj", "a:.."));
    expectConfig(() => agentMemoryPath("proj", ".:keeper"));
    expectConfig(() => agentMemoryPath("proj", "..:keeper"));
  });

  it("REQ-C3 AC4 — every derived path stays inside <runtimeRoot>/.maister/<slug>/agents/", () => {
    const confine = path.join(root, ".maister", "proj", "agents");

    for (const id of ["core:keeper", "a:b/c", "a:..%2F..", "pkg:s p a c e"]) {
      let derived: string;

      try {
        derived = agentMemoryPath("proj", id);
      } catch {
        continue;
      }

      expect(path.resolve(derived).startsWith(`${confine}${path.sep}`)).toBe(
        true,
      );
    }
  });

  it("REQ-C3 AC5 — an id with no colon is a CONFIG refusal, never a single-level fallback", () => {
    expectConfig(() => agentMemoryPath("proj", "keeper"));
    expectConfig(() => agentMemoryPath("proj", ""));
  });

  it("REQ-C3 AC6 — the path is keyed by qualified id only; nothing revision-shaped appears in it", () => {
    expect(agentMemoryPath("proj", "core:keeper")).toBe(
      agentMemoryPath("proj", "core:keeper"),
    );
    expect(agentMemoryPath("proj", "core:keeper")).not.toContain("v1.0.0");
  });
});

describe("hashAgentMemory", () => {
  it("is stable for identical bytes and differs on a single changed byte", () => {
    expect(hashAgentMemory("hello")).toBe(hashAgentMemory("hello"));
    expect(hashAgentMemory("hello")).not.toBe(hashAgentMemory("hellp"));
  });
});

describe("readAgentMemory / writeAgentMemory", () => {
  it("returns null for an absent file — the first-writer state", async () => {
    await expect(readAgentMemory("proj", "core:keeper")).resolves.toBeNull();
  });

  it("round-trips content, size and hash through an atomic write", async () => {
    const written = await writeAgentMemory("proj", "core:keeper", "# notes\n");

    expect(written.hash).toBe(hashAgentMemory("# notes\n"));

    const read = await readAgentMemory("proj", "core:keeper");

    expect(read).toEqual({
      content: "# notes\n",
      hash: hashAgentMemory("# notes\n"),
      sizeChars: "# notes\n".length,
    });
  });

  it("REQ-C5 — degrades to null when the path is not a readable regular file", async () => {
    const derived = agentMemoryPath("proj", "core:keeper");

    await mkdir(derived, { recursive: true });

    await expect(readAgentMemory("proj", "core:keeper")).resolves.toBeNull();
  });

  it("REQ-C5 / REQ-C11 AC3 — degrades to null on an over-cap READ rather than throwing", async () => {
    process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = "8";
    const derived = agentMemoryPath("proj", "core:keeper");

    await mkdir(path.dirname(derived), { recursive: true });
    await writeFile(derived, "x".repeat(9), "utf8");

    await expect(readAgentMemory("proj", "core:keeper")).resolves.toBeNull();
  });
});

describe("T-C11 / REQ-C11 — the character cap", () => {
  it("REQ-C11 AC1 — defaults to 32768 characters", () => {
    expect(agentMemoryMaxChars()).toBe(32_768);
  });

  it("REQ-C11 AC2 — an invalid, zero, or negative value falls back to the default", () => {
    for (const raw of ["nonsense", "0", "-5"]) {
      process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = raw;
      expect(agentMemoryMaxChars()).toBe(32_768);
    }
  });

  it("REQ-C11 AC1 — an explicit positive value is honored", () => {
    process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = "1234";
    expect(agentMemoryMaxChars()).toBe(1234);
  });

  it("REQ-C11 AC3 — a write of exactly `max` is accepted and `max + 1` is refused CONFIG", async () => {
    process.env.MAISTER_AGENT_MEMORY_MAX_CHARS = "16";

    await expect(
      writeAgentMemory("proj", "core:keeper", "x".repeat(16)),
    ).resolves.toMatchObject({ hash: hashAgentMemory("x".repeat(16)) });

    await expect(
      writeAgentMemory("proj", "core:keeper", "x".repeat(17)),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
