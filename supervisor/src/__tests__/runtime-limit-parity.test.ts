import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_OBJECT_RESPONSE_BYTES } from "../../../runtime/object-integrity";
import {
  MAX_ACTIVE_OBJECT_READS,
  MAX_OBJECT_RESPONSE_SPOOL_BYTES,
} from "../runtime-object-files";
import { RUNTIME_LIMIT_ENV_KEYS } from "../runtime-limits";

const repo = resolve(__dirname, "../../..");
const read = (path: string): string =>
  readFileSync(resolve(repo, path), "utf8");

// D11/S3.7: every host runtime limit is declared on every operator surface the
// documented deployment reads, so a setting cannot exist on one host and be
// silently absent on another.
const ENV_SURFACES = [
  ".env.example",
  "supervisor/.env.sample",
  "deploy/maister.env.example",
] as const;

describe("runtime limit deployment parity", () => {
  it.each(ENV_SURFACES)("declares every runtime limit key in %s", (surface) => {
    const text = read(surface);
    const missing = Object.values(RUNTIME_LIMIT_ENV_KEYS).filter(
      (key) => !new RegExp(`^#?\\s*${key}=`, "m").test(text),
    );

    expect(missing).toEqual([]);
  });

  it("documents every runtime limit key in the configuration table", () => {
    const text = read("docs/configuration.md");
    const missing = Object.values(RUNTIME_LIMIT_ENV_KEYS).filter(
      (key) => !text.includes(`\`${key}\``),
    );

    expect(missing).toEqual([]);
  });

  it("documents the read response, scan and spool bounds the host enforces", () => {
    const row = read("docs/configuration.md")
      .split("\n")
      .find((line) => line.startsWith("| Read response/range |"));

    expect(row).toBeDefined();
    expect(row).toContain(`≤${MAX_OBJECT_RESPONSE_BYTES / 1024 / 1024} MiB`);
    expect(row).toContain(
      `≤${MAX_ACTIVE_OBJECT_READS} concurrent verification scans`,
    );
    expect(row).toContain(
      `response spool ≤${MAX_OBJECT_RESPONSE_SPOOL_BYTES / 1024 / 1024} MiB total`,
    );
  });
});
