import "server-only";

import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "@/lib/evaluations/digest";

export type PushGateInput = {
  directory: string;
  commitSha: string;
  destination: string;
  remoteBase: string | null;
  originalHook: string | null;
  originalHookDigest: string | null;
  url: string;
};

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Git supplies the advertised remote old OID; server CAS remains the final authority. */
export async function writeReviewedPushGate(input: PushGateInput): Promise<{
  hooksDirectory: string;
  digest: string;
  files: Record<"gate.cjs" | "pre-push", string>;
}> {
  await mkdir(input.directory, { mode: 0o700 });
  const expected = {
    commitSha: input.commitSha,
    destination: input.destination,
    remoteBase: input.remoteBase ?? "0".repeat(40),
    originalHook: input.originalHook,
    originalHookDigest: input.originalHookDigest,
    url: input.url,
  };
  const script = `"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const expected = ${JSON.stringify(expected)};
const buffer = Buffer.alloc(4097);
let length = 0;
while (length < buffer.length) {
  const size = fs.readSync(0, buffer, length, buffer.length - length, null);
  if (size === 0) break;
  length += size;
}
const input = buffer.subarray(0, length).toString("utf8");
const lines = input.trimEnd().split("\\n");
const fields = lines.length === 1 ? lines[0].split(" ") : [];
const noUpdate = length === 0 && expected.remoteBase === expected.commitSha;
if (process.argv[3] !== expected.url || length > 4096 || (!noUpdate && (fields.length !== 4 || fields[1] !== expected.commitSha || fields[2] !== expected.destination || fields[3] !== expected.remoteBase))) {
  process.stderr.write("MAISTER_PUSH_BASELINE_REFUSED: Reviewed push baseline changed. Create a fresh push preview.\\n");
  process.exit(1);
}
if (expected.originalHook) {
  const { createHash } = require("node:crypto");
  const info = fs.lstatSync(expected.originalHook);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576 || !(info.mode & 73) || createHash("sha256").update(fs.readFileSync(expected.originalHook)).digest("hex") !== expected.originalHookDigest) {
    process.stderr.write("MAISTER_PUSH_HOOK_REFUSED: Hook changed after review.\\n");
    process.exit(1);
  }
  const result = spawnSync(expected.originalHook, process.argv.slice(2), { input, stdio: ["pipe", "inherit", "inherit"], timeout: 20000 });
  if (result.error || result.signal || result.status !== 0) { process.stderr.write("MAISTER_PUSH_HOOK_REFUSED\\n"); process.exit(result.status || 1); }
}
`;
  const gatePath = join(input.directory, "gate.cjs");
  const hookPath = join(input.directory, "pre-push");
  const wrapper = `#!/bin/sh\nexec ${shellLiteral(process.execPath)} ${shellLiteral(gatePath)} "$@"\n`;

  await writeFile(gatePath, script, { mode: 0o600, flag: "wx" });
  await writeFile(hookPath, wrapper, { mode: 0o700, flag: "wx" });
  await chmod(hookPath, 0o700);

  for (const path of [gatePath, hookPath, input.directory]) {
    const handle = await open(path, "r");

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  return {
    files: { "gate.cjs": sha256(script), "pre-push": sha256(wrapper) },
    hooksDirectory: input.directory,
    digest: sha256(script + "\0" + wrapper),
  };
}
