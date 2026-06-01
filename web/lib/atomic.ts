import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
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

export async function atomicWriteBuffer(
  path: string,
  data: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;

  log.debug(
    { path, tmpPath, byteSize: data.byteLength },
    "atomicWriteBuffer start",
  );
  try {
    const handle = await open(tmpPath, "w");

    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, path);
    log.debug({ path, byteSize: data.byteLength }, "atomicWriteBuffer done");
  } catch (err) {
    log.error(
      { err, path },
      "atomicWriteBuffer failed; attempting tmp cleanup",
    );
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
