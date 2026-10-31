import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { OperationalResourceKind } from "@/lib/run-results/operational-types";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink, realpath } from "node:fs/promises";
import path from "node:path";

import { captureOperationalBaseline } from "@/lib/agents/operational-integrity";
import { MaisterError } from "@/lib/errors";
import { publishRuntimeObject } from "@/lib/execution-host/runtime-objects";

const exec = promisify(execFile);
const CHUNK_BYTES = 1024 * 1024;
const PACK_BYTES = 8 * 1024 * 1024;

function evidenceId(runId: string, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(runId).update(bytes).digest("hex");

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** A bounded, reversible NDJSON archive includes ignored/binary files and links.
 * Only opaque immutable objects leave the checkout; no source bytes enter DB.
 */
export async function preserveOperationalEvidence(input: {
  runId: string;
  cwd: string;
  resourceKind: OperationalResourceKind;
  client: BoundClient;
  renew: () => Promise<void>;
}): Promise<string[]> {
  const snapshot = await captureOperationalBaseline(
    input.cwd,
    input.resourceKind,
  );
  const root = await realpath(input.cwd);
  const objectIds: string[] = [];
  let parts: string[] = [];
  let size = 0;
  let total = 0;
  const publish = async (
    bytes: Uint8Array,
    logicalName: string,
  ): Promise<string> => {
    await input.renew();
    const result = await publishRuntimeObject({
      client: input.client,
      objectId: evidenceId(input.runId, bytes),
      kind: "diagnostic",
      logicalName,
      mimeType: "application/x-ndjson",
      retentionClass: "run",
      bytes,
    });

    await input.renew();

    return result.objectId;
  };
  const flush = async (): Promise<void> => {
    if (size === 0) return;
    const id = await publish(
      new TextEncoder().encode(parts.join("")),
      `operational-diagnosis-${objectIds.length}.ndjson`,
    );

    objectIds.push(id);
    parts = [];
    size = 0;
  };
  const append = async (record: object): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;

    total += Buffer.byteLength(line);
    if (total > 384 * 1024 * 1024)
      throw new MaisterError(
        "PRECONDITION",
        "operational diagnosis exceeds the bounded archive limit",
        { details: { reason: "operational_evidence_limit" } },
      );
    if (size + Buffer.byteLength(line) > PACK_BYTES) await flush();
    parts.push(line);
    size += Buffer.byteLength(line);
  };

  for (const entry of snapshot.source) {
    const absolute = path.join(root, entry.path);

    if ((await realpath(path.dirname(absolute))) !== path.dirname(absolute))
      throw new MaisterError(
        "PRECONDITION",
        "diagnostic source path changed during preservation",
        { details: { reason: "operational_evidence_race" } },
      );
    if (entry.type === "symlink") {
      await append({ ...entry, target: await readlink(absolute) });
    } else if (entry.type === "file") {
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const hash = createHash("sha256");
      let offset = 0;

      try {
        await append({ ...entry, record: "file" });
        const buffer = Buffer.alloc(CHUNK_BYTES);

        while (true) {
          const read = await handle.read(buffer, 0, buffer.length, null);

          if (!read.bytesRead) break;
          hash.update(new Uint8Array(buffer.subarray(0, read.bytesRead)));
          await append({
            path: entry.path,
            offset,
            bytes: buffer.subarray(0, read.bytesRead).toString("base64"),
          });
          offset += read.bytesRead;
          if (offset > 256 * 1024 * 1024)
            throw new MaisterError(
              "PRECONDITION",
              "diagnostic file exceeds preservation limit",
              { details: { reason: "operational_evidence_limit" } },
            );
        }
      } finally {
        await handle.close();
      }
      if (hash.digest("hex") !== entry.sha256)
        throw new MaisterError(
          "CONFLICT",
          "diagnostic bytes changed during preservation",
          { details: { reason: "operational_evidence_race" } },
        );
    } else await append(entry);
  }
  if (input.resourceKind !== "plain_directory") {
    const git = async (args: string[]): Promise<string> => {
      await input.renew();
      const result = await exec(
        "git",
        ["-C", root, "-c", "core.fsmonitor=false", ...args],
        {
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );

      return result.stdout;
    };
    const heads = [
      ...new Set(
        (await git(["reflog", "show", "--format=%H", "HEAD"]))
          .trim()
          .split("\n")
          .filter(Boolean),
      ),
    ];

    if (
      heads.length > 64 ||
      heads.some((sha) => !/^[a-f0-9]{40,64}$/.test(sha))
    )
      throw new MaisterError(
        "PRECONDITION",
        "operational Git history exceeds the bounded diagnosis limit",
        { details: { reason: "operational_evidence_limit" } },
      );
    await append({ record: "git_reflog_heads", heads });
    const appendPatch = async (
      record: string,
      patch: string,
      sha?: string,
    ): Promise<void> => {
      const bytes = Buffer.from(patch);

      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
        await append({
          record,
          sha,
          offset,
          bytes: bytes
            .subarray(offset, offset + CHUNK_BYTES)
            .toString("base64"),
        });
    };

    for (const sha of heads)
      await appendPatch(
        "git_commit_patch",
        await git([
          "show",
          "--format=fuller",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          sha,
          "--",
        ]),
        sha,
      );
    await appendPatch(
      "git_index_patch",
      await git([
        "diff",
        "--cached",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "--",
      ]),
    );
  }
  await flush();
  const { capturedAt: _capturedAt, ...witness } = snapshot;
  const manifest = await publish(
    new TextEncoder().encode(
      `${JSON.stringify({ version: 1, format: "maister.operational.diagnosis.ndjson.v1", runId: input.runId, witness, parts: objectIds })}\n`,
    ),
    "operational-diagnosis-manifest.ndjson",
  );

  return [manifest, ...objectIds];
}
