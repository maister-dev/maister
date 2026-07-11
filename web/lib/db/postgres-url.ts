import { MaisterError } from "../errors";

const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export function maskDbUrl(value: string): string {
  return value.replace(/(:\/\/[^:]+:)([^@]+)(@)/, "$1***$3");
}

export function resolvePostgresDbUrl(
  value: string | undefined = process.env.DB_URL,
): string {
  if (!value) {
    throw new MaisterError(
      "CONFIG",
      "Postgres DB_URL is required (postgres://... or postgresql://...)",
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new MaisterError(
      "CONFIG",
      "Postgres DB_URL is required and must be a valid postgres:// or postgresql:// URL",
    );
  }

  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new MaisterError(
      "CONFIG",
      "Postgres DB_URL is required; received an unsupported protocol",
    );
  }

  return value;
}
