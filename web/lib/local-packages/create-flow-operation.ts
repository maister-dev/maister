import "server-only";

import type { CreateFlowInput } from "@/lib/local-packages/create-flow-contract";

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { atomicWriteText } from "@/lib/atomic";
import { createFlowInputSchema } from "@/lib/local-packages/create-flow-contract";
import { MaisterError } from "@/lib/errors";

export type LocalPackageCreationJournal = {
  flow: CreateFlowInput;
  originalManifest?: string;
};

const operationIdSchema = z.string().uuid();
const journalSchema = z
  .object({
    flow: createFlowInputSchema,
    originalManifest: z.string().optional(),
  })
  .strict();

function creationJournalPath(workingDir: string, operationId: string): string {
  const parsed = operationIdSchema.safeParse(operationId);

  if (!parsed.success) {
    throw new MaisterError("CONFIG", "invalid local package creation operation id");
  }

  return path.join(workingDir, ".maister", "creation", `${parsed.data}.json`);
}

export async function writeCreationJournal(
  workingDir: string,
  operationId: string,
  journal: LocalPackageCreationJournal,
): Promise<void> {
  const journalPath = creationJournalPath(workingDir, operationId);

  await mkdir(path.dirname(journalPath), { recursive: true });
  await atomicWriteText(journalPath, JSON.stringify(journal));
}

export async function readCreationJournal(
  workingDir: string,
  operationId: string,
): Promise<LocalPackageCreationJournal | null> {
  const journalPath = creationJournalPath(workingDir, operationId);
  let raw: string;

  try {
    raw = await readFile(journalPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new MaisterError(
      "CONFIG",
      "local package creation recovery journal is unreadable",
    );
  }

  const parsed = journalSchema.safeParse(value);

  if (!parsed.success) {
    throw new MaisterError(
      "CONFIG",
      "local package creation recovery journal is invalid",
    );
  }

  return parsed.data;
}

export async function removeCreationJournal(
  workingDir: string,
  operationId: string,
): Promise<void> {
  const journalPath = creationJournalPath(workingDir, operationId);

  await rm(journalPath, { force: true });
}
