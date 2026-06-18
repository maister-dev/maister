import "server-only";

import { readFile } from "node:fs/promises";

import pino from "pino";
import { isSeq, parseDocument } from "yaml";

import { atomicWriteText } from "@/lib/atomic";

const log = pino({
  name: "package-yaml-writeback",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PackagesPinEntry = {
  id: string;
  source: string;
  version: string;
  path?: string;
};

export type WriteBackOp =
  | { op: "upsert"; entry: PackagesPinEntry }
  | { op: "remove"; id: string };

export type WriteBackResult = "ok" | "failed" | "skipped";

// ADR-088: after an attach/detach/upgrade transaction COMMITS, the project's
// `maister.yaml packages[]` pin is rewritten so the project can be re-raised
// on another instance from git alone. Comment-preserving (yaml Document API)
// + atomic (tmp + rename). A failure NEVER rolls back the DB operation — the
// caller surfaces `writeBack: "failed"`; the next mutation (or a manual
// edit) heals the file.
export async function writeBackPackagesPin(opts: {
  maisterYamlPath: string | null;
  change: WriteBackOp;
}): Promise<WriteBackResult> {
  // ADR-093: a DB-only project (registered with no maister.yaml) has nothing to
  // write back to — a benign no-op, never a failure. The persist banner nudges
  // the operator to materialize the manifest later.
  if (opts.maisterYamlPath === null) {
    log.info(
      { op: opts.change.op },
      "packages[] write-back skipped — config lives only in the DB",
    );

    return "skipped";
  }

  try {
    const raw = await readFile(opts.maisterYamlPath, "utf8");
    const doc = parseDocument(raw);

    if (doc.errors.length > 0) {
      throw new Error(`yaml parse: ${doc.errors[0]!.message}`);
    }

    if (opts.change.op === "upsert") {
      const entry = opts.change.entry;
      const node: Record<string, string> = {
        id: entry.id,
        source: entry.source,
        version: entry.version,
      };

      if (entry.path !== undefined) node.path = entry.path;

      const seq = doc.get("packages", true);

      if (!isSeq(seq)) {
        doc.set("packages", doc.createNode([node]));
      } else {
        const existing = seq.items.findIndex(
          (item: any) =>
            typeof item?.get === "function" && item.get("id") === entry.id,
        );

        if (existing >= 0) {
          seq.items.splice(existing, 1, doc.createNode(node) as never);
        } else {
          seq.items.push(doc.createNode(node) as never);
        }
      }
    } else {
      const removeId = opts.change.id;
      const seq = doc.get("packages", true);

      if (isSeq(seq)) {
        seq.items = seq.items.filter(
          (item: any) =>
            !(typeof item?.get === "function" && item.get("id") === removeId),
        );
      }
    }

    await atomicWriteText(opts.maisterYamlPath, doc.toString());
    log.info(
      { path: opts.maisterYamlPath, op: opts.change.op },
      "packages[] pin written back",
    );

    return "ok";
  } catch (err) {
    log.warn(
      {
        path: opts.maisterYamlPath,
        op: opts.change.op,
        cause: (err as Error).message,
      },
      "packages[] write-back failed — DB remains the runtime truth",
    );

    return "failed";
  }
}
