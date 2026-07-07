import "server-only";

type SelectForUpdateQuery<Row extends Record<string, unknown>> = PromiseLike<
  Row[]
> & {
  for?: (mode: "update") => Promise<Row[]>;
};

export async function selectForUpdate<Row extends Record<string, unknown>>(
  query: SelectForUpdateQuery<Row>,
): Promise<Row[]> {
  if (typeof query.for === "function") {
    return await query.for("update");
  }

  return await query;
}
