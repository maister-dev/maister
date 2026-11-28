// Task 10 (docs/database-schema.md §Hot-path query plan contract) — captures
// the exact SQL statements a public reader executes against a real pg Pool and
// runs `EXPLAIN (FORMAT JSON)` on each one touching `tables` with sequential
// scans and sorts disabled. Disabling seqscan/sort proves predicate provability
// and column-order match without cost-model flakiness or exporting private
// query builders.
import type { Pool, PoolClient, QueryConfig } from "pg";

export type CapturedQuery = {
  readonly text: string;
  readonly values: readonly unknown[];
};

export type CapturePlansResult = {
  readonly indexNames: ReadonlySet<string>;
};

export type CapturePlansOptions = {
  /** Postgres table names whose statements should be EXPLAINed. */
  readonly tables: readonly string[];
  /** Optional hook fired whenever a matching statement is captured. */
  readonly onCapture?: (query: CapturedQuery) => void;
  /** Disable planner sorts (default true); set false for BitmapOr+Sort scans. */
  readonly disableSort?: boolean;
};

const IGNORED_LEADING_KEYWORDS =
  /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|SHOW|EXPLAIN|ANALYZE|DEALLOCATE)\b/i;

function extractQuery(args: unknown[]): CapturedQuery | null {
  const first = args[0];

  if (typeof first === "string") {
    const values = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];

    return { text: first, values };
  }
  if (first !== null && typeof first === "object" && "text" in first) {
    const cfg = first as QueryConfig;

    if (typeof cfg.text === "string") {
      const values = Array.isArray(cfg.values)
        ? cfg.values
        : Array.isArray(args[1])
          ? (args[1] as unknown[])
          : [];

      return { text: cfg.text, values };
    }
  }

  return null;
}

function matchesTables(
  sqlText: string,
  tableMatchers: readonly RegExp[],
): boolean {
  if (IGNORED_LEADING_KEYWORDS.test(sqlText)) return false;

  return tableMatchers.some((re) => re.test(sqlText));
}

function collectIndexNames(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectIndexNames(item, out);

    return;
  }
  const record = node as Record<string, unknown>;

  if (typeof record["Index Name"] === "string") {
    out.add(record["Index Name"]);
  }
  if ("Plan" in record) collectIndexNames(record["Plan"], out);
  if (Array.isArray(record["Plans"])) {
    for (const child of record["Plans"]) collectIndexNames(child, out);
  }
}

export async function capturePlans(
  pool: Pool,
  run: () => Promise<unknown>,
  opts: CapturePlansOptions,
): Promise<CapturePlansResult> {
  const tableMatchers = opts.tables.map(
    (table) => new RegExp(`\\b"?${table}"?\\b`, "i"),
  );
  const captured: CapturedQuery[] = [];
  const record = (args: unknown[]): void => {
    const query = extractQuery(args);

    if (!query || !matchesTables(query.text, tableMatchers)) return;
    captured.push(query);
    opts.onCapture?.(query);
  };

  const origPoolQuery = pool.query.bind(pool) as (
    ...args: unknown[]
  ) => unknown;
  const origPoolConnect = pool.connect.bind(pool) as (
    ...args: unknown[]
  ) => unknown;

  const wrapClient = (client: PoolClient): PoolClient => {
    const origClientQuery = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    const origRelease = client.release.bind(client) as (
      ...args: unknown[]
    ) => unknown;

    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      record(args);

      return origClientQuery(...args);
    };
    (
      client as unknown as { release: (...args: unknown[]) => unknown }
    ).release = (...args: unknown[]) => {
      (client as unknown as { query: unknown }).query = origClientQuery;
      (client as unknown as { release: unknown }).release = origRelease;

      return origRelease(...args);
    };

    return client;
  };

  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (
    ...args: unknown[]
  ) => {
    record(args);

    return origPoolQuery(...args);
  };
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (
    ...args: unknown[]
  ) => {
    if (typeof args[0] === "function") {
      const cb = args[0] as (
        err: Error | undefined,
        client: PoolClient | undefined,
        done: (release?: unknown) => void,
      ) => void;

      return origPoolConnect(
        (
          err: Error | undefined,
          client: PoolClient | undefined,
          done: (release?: unknown) => void,
        ) => {
          cb(err, client ? wrapClient(client) : client, done);
        },
      );
    }

    return (origPoolConnect(...args) as Promise<PoolClient>).then(wrapClient);
  };

  try {
    await run();
  } finally {
    (pool as unknown as { query: unknown }).query = origPoolQuery;
    (pool as unknown as { connect: unknown }).connect = origPoolConnect;
  }

  const allIndexes = new Set<string>();
  const explainClient = await pool.connect();

  try {
    await explainClient.query("BEGIN");
    await explainClient.query("SET LOCAL enable_seqscan = off");
    if (opts.disableSort !== false) {
      await explainClient.query("SET LOCAL enable_sort = off");
    }

    for (const stmt of captured) {
      const explainRes = await explainClient.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON) ${stmt.text}`,
        [...stmt.values],
      );

      collectIndexNames(explainRes.rows[0]?.["QUERY PLAN"] ?? null, allIndexes);
    }

    await explainClient.query("ROLLBACK");
  } catch (error) {
    await explainClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    explainClient.release();
  }

  return { indexNames: allIndexes };
}
