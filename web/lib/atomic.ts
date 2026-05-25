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
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;

  log.debug({ path, tmpPath }, "atomicWriteJson start");
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), {
      encoding: "utf8",
    });
    await rename(tmpPath, path);
    log.debug({ path }, "atomicWriteJson done");
  } catch (err) {
    log.error(
      { err, path },
      "atomicWriteJson failed; attempting tmp cleanup",
    );
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
