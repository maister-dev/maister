import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  readCreationJournal,
  removeCreationJournal,
  writeCreationJournal,
} from "@/lib/local-packages/create-flow-operation";

let workingDir: string | undefined;

afterEach(async () => {
  if (workingDir) await rm(workingDir, { recursive: true, force: true });
  workingDir = undefined;
});

const FLOW = {
  id: "bugfix",
  metadata: {
    title: "Fix a bug",
    summary: "Repair a confirmed defect.",
    route_when: "A report has reproduction steps.",
  },
};

describe("local-package creation journal", () => {
  it("keeps recovery input in the ignored private journal rather than the DB state", async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), "create-flow-journal-"));
    const operationId = "60f734a5-0c42-4f97-8e73-c8c6e0d72b4f";

    await writeCreationJournal(workingDir, operationId, {
      flow: FLOW,
      originalManifest: "schemaVersion: 1\nname: pkg\nflows: []\n",
    });

    await expect(readCreationJournal(workingDir, operationId)).resolves.toEqual({
      flow: FLOW,
      originalManifest: "schemaVersion: 1\nname: pkg\nflows: []\n",
    });

    await removeCreationJournal(workingDir, operationId);
    await expect(readCreationJournal(workingDir, operationId)).resolves.toBeNull();
  });

  it("fails closed when a recovery journal is malformed", async () => {
    workingDir = await mkdtemp(path.join(tmpdir(), "create-flow-journal-"));
    const operationId = "a92a7581-40e7-459b-9b68-c14d858da753";
    const journalPath = path.join(
      workingDir,
      ".maister",
      "creation",
      `${operationId}.json`,
    );

    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, "not-json", "utf8");

    await expect(readCreationJournal(workingDir, operationId)).rejects.toEqual(
      expect.objectContaining<Partial<MaisterError>>({ code: "CONFIG" }),
    );
  });
});
