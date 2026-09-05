import { MaisterError } from "@/lib/errors";

export type ProjectionLimits = Readonly<{
  concurrency: number;
  batchRows: number;
  batchBytes: number;
  leaseMs: number;
}>;

export const DEFAULT_PROJECTION_LIMITS: ProjectionLimits = Object.freeze({
  concurrency: 2,
  batchRows: 100,
  batchBytes: 1_048_576,
  leaseMs: 30_000,
});

const SETTINGS: Readonly<
  Record<keyof ProjectionLimits, readonly [string, number, number]>
> = {
  concurrency: ["MAISTER_PROJECTION_CONCURRENCY", 1, 2],
  batchRows: ["MAISTER_PROJECTION_BATCH_ROWS", 1, 100],
  batchBytes: ["MAISTER_PROJECTION_BATCH_BYTES", 1, 1_048_576],
  leaseMs: ["MAISTER_PROJECTION_LEASE_MS", 30_000, 60_000],
};

/** Deployment overrides may reduce work quanta, never raise protocol ceilings. */
export function projectionLimitsFromEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): ProjectionLimits {
  const result: Record<keyof ProjectionLimits, number> = {
    ...DEFAULT_PROJECTION_LIMITS,
  };

  for (const key of Object.keys(SETTINGS) as Array<keyof ProjectionLimits>) {
    const [name, minimum, maximum] = SETTINGS[key];
    const raw = env[name];

    if (raw === undefined) continue;
    const value = Number(raw);

    if (
      !/^[1-9][0-9]{0,6}$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    )
      throw new MaisterError(
        "CONFIG",
        `${name} must be an integer from ${minimum} through ${maximum}`,
      );
    result[key] = value;
  }

  return Object.freeze(result);
}
