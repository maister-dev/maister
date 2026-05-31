import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import pino from "pino";

const log = pino({ name: "atomic" });

export async function atomicWriteJson(
  path: string,
  data: unknown,
): Promise<void> {
  await atomicWriteText(path, JSON.stringify(data, null, 2));
}

export async function atomicWriteText(
  path: string,
  data: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;

  log.debug({ path, tmpPath }, "atomicWriteText start");
  try {
    await writeFile(tmpPath, data, { encoding: "utf8" });
    await rename(tmpPath, path);
    log.debug({ path }, "atomicWriteText done");
  } catch (err) {
    log.error({ err, path }, "atomicWriteText failed; attempting tmp cleanup");
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
