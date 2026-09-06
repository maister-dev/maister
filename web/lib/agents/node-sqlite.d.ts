declare module "node:sqlite" {
  export class StatementSync {
    run(...params: Array<string | number | bigint | null | Uint8Array>): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  }
  export class DatabaseSync {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
