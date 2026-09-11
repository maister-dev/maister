declare module "node:sqlite" {
  export class StatementSync {
    run(...params: Array<string | number | bigint | null | Uint8Array>): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    get(
      ...params: Array<string | number | bigint | null | Uint8Array>
    ): Record<string, unknown> | undefined;
    all(
      ...params: Array<string | number | bigint | null | Uint8Array>
    ): Array<Record<string, unknown>>;
  }
  export class DatabaseSync {
    constructor(filename: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
