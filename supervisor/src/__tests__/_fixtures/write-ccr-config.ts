import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WriteCcrConfigArgs = {
  host?: string;
  port?: number;
  extra?: Record<string, unknown>;
  raw?: string;
};

export async function writeCcrConfig(
  args: WriteCcrConfigArgs = {},
): Promise<string> {
  const dir = join(
    tmpdir(),
    `mock-ccr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  await mkdir(dir, { recursive: true });

  const path = join(dir, "config.json");

  if (args.raw !== undefined) {
    await writeFile(path, args.raw, "utf8");

    return path;
  }

  const body: Record<string, unknown> = {
    Providers: [],
    Router: {},
    ...args.extra,
  };

  if (args.host !== undefined) body.HOST = args.host;
  if (args.port !== undefined) body.PORT = args.port;

  await writeFile(path, JSON.stringify(body), "utf8");

  return path;
}
